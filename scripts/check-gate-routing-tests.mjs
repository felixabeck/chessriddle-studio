import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkGateRouting,
  pnpmReferences,
  workflowJobs,
  workflowStepBlocks,
  workflowSteps,
} from "./check-gate-routing.mjs";
import { gitInit } from "./test-git-init.mjs";
import { testTempRoots } from "./test-temp-root.mjs";
import { spawnSync } from "node:child_process";
import { mutationPackages } from "./frontend-mutation-packages.mjs";

const temporaryRoot = testTempRoots(after);

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT_CHAIN =
  "pnpm mutation:guard:check && pnpm lint:ci && pnpm tauri:boundary:check && pnpm rust:surface:check && pnpm ui:boundary:check && pnpm gates:routing:check && pnpm gates:routing:test && pnpm ci:remote:test && pnpm tools:parity:check && pnpm tools:parity:test && pnpm workflows:check && pnpm workflows:permissions:test && pnpm ui:boundary:report:test && pnpm coverage:report:test && pnpm bundle:report:test && pnpm mutation:runner:test && pnpm rust:target:evict:test && pnpm gates:logs:test && pnpm gates:parallelism:test && pnpm gates:push:test && pnpm gates:child-supervisor:test && pnpm gates:imports:test && pnpm rust:windows:test && pnpm entrypoint:test && pnpm e2e:launchers:test && pnpm install:local:test && pnpm app:driver:test && ./scripts/findings.py check && pnpm ipc:consumers:check && pnpm extension:test";

async function write(root, relativePath, contents) {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

async function fixture() {
  const root = await temporaryRoot("gate-routing-");
  gitInit(root);
  await write(
    root,
    "package.json",
    JSON.stringify({
      scripts: {
        "all:check": "node scripts/check-example.mjs && pnpm nested:check",
        "nested:check": "node scripts/nested.mjs",
        "example:test": "node --test scripts/example-tests.mjs",
        "gates:contract:check":
          "pnpm mutation:guard:check && pnpm gates:child-supervisor:test && pnpm gates:imports:test && pnpm all:check && pnpm example:test",
        "gates:push": "node scripts/run-push-gates.mjs",
        "checks:pre-review": "node scripts/run-push-gates.mjs --pre-review",
        "gates:child-supervisor:test": "node --test scripts/child-supervisor-tests.mjs",
        "gates:imports:test": "node --test scripts/import-path-tests.mjs",
        "mutation:guard:check": "true",
        "rust:target:evict": "node scripts/rust-target-eviction.mjs",
        "findings:kit:check": "env -u KIT_ROOT kit sync --check .",
        "rust:windows:check": "true",
        "test:coverage": "true",
        "coverage:frontend:check": "true",
        "coverage:mapping:frontend": "true",
        "build-vite": "true",
        "bindings:check": "true",
        "bundle:check": "true",
        "test:e2e:container": "true",
        "test:coverage:backend": "true",
        "coverage:backend:check": "true",
        "coverage:mapping:backend": "true",
      },
    }),
  );
  await write(
    root,
    ".claude/skills/push/SKILL.md",
    "## 2. Gates\n\n```bash\npnpm gates:push -- <blocks>\n```\n\n### Unconditional contract gate\n\n```bash\npnpm gates:contract:check\n```\n\n### Rust/Tauri backend\n\n```bash\nbash scripts/setup-rust.sh\ncargo fmt --manifest-path src-tauri/Cargo.toml -- --check\ncargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings\npnpm rust:windows:check\n```\n\n### TypeScript/React frontend\n\n```bash\npnpm build-vite\npnpm bundle:check\n```\n\n### Cross-layer contracts\n\n```bash\npnpm bindings:check\n```\n\n### Findings ledger\n\n```bash\nenv -u KIT_ROOT pnpm findings:kit:check\n```\n\n## 2a. Pre-review checks\n\n```bash\npnpm checks:pre-review\n```\n\n```bash\npnpm build-vite\npnpm exec oxfmt --check <changed-format-files>\npnpm exec oxlint --deny-warnings <changed-js-ts-files>\npnpm exec tsgo --noEmit\ncargo fmt --manifest-path src-tauri/Cargo.toml -- --check\npnpm coverage:mapping:frontend\npnpm coverage:mapping:backend\npnpm rust:windows:check\npnpm bundle:check\n```\n\n## 3. Review\n\n```text\nscripts/**\n```\n\n## 4. Finish\n",
  );
  await write(
    root,
    ".github/workflows/test.yml",
    "steps:\n  - name: Contract\n    run: pnpm gates:contract:check\n  - name: Frontend coverage\n    run: pnpm test:coverage\n  - name: Frontend ratchet\n    run: pnpm coverage:frontend:check\n  - name: Frontend build\n    run: pnpm build-vite\n  - name: Bindings\n    run: pnpm bindings:check\n  - name: Bundle\n    run: pnpm bundle:check\n  - name: Browser\n    run: pnpm test:e2e:container\n  - name: Rust gates\n    run: |\n      cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings\n  - name: Rust tests\n    run: cargo test --manifest-path src-tauri/Cargo.toml --all-targets\n  - name: Backend coverage\n    run: pnpm test:coverage:backend\n  - name: Backend ratchet\n    run: pnpm coverage:backend:check\n",
  );
  await write(root, "vite.config.ts", 'test: { include: ["scripts/**/*.test.mjs"] },\n');
  await write(root, "scripts/check-example.mjs", "\n");
  await write(root, "scripts/example-tests.mjs", "\n");
  await write(root, "scripts/tool.py", "\n");
  return root;
}

const paths = ["scripts/check-example.mjs"];

test("accepts routed tests, nested scripts, allowed tools, and live sensitive globs", async () => {
  const root = await fixture();
  assert.deepEqual(await checkGateRouting(root, { paths }), []);
});

test("gate runner package scripts pin the plain node invocations without an outer agent-gate wrapper", async (t) => {
  const cases = [
    {
      title: "gates:push with an outer agent-gate wrapper is rejected",
      script: "gates:push",
      replacement: "agent-gate node scripts/run-push-gates.mjs",
      expected: /package\.json gates:push must invoke node scripts\/run-push-gates\.mjs/u,
    },
    {
      title: "checks:pre-review with an outer agent-gate wrapper is rejected",
      script: "checks:pre-review",
      replacement: "agent-gate node scripts/run-push-gates.mjs --pre-review",
      expected:
        /package\.json checks:pre-review must invoke node scripts\/run-push-gates\.mjs --pre-review/u,
    },
    {
      title: "checks:pre-review without --pre-review is rejected",
      script: "checks:pre-review",
      replacement: "node scripts/run-push-gates.mjs",
      expected:
        /package\.json checks:pre-review must invoke node scripts\/run-push-gates\.mjs --pre-review/u,
    },
    {
      title: "gates:push with a command -v fallback is rejected",
      script: "gates:push",
      replacement:
        "if command -v agent-gate >/dev/null 2>&1; then agent-gate node scripts/run-push-gates.mjs; else node scripts/run-push-gates.mjs; fi",
      expected: /package\.json gates:push must invoke node scripts\/run-push-gates\.mjs/u,
    },
  ];
  for (const { title, script, replacement, expected } of cases) {
    await t.test(title, async () => {
      const root = await fixture();
      const packagePath = join(root, "package.json");
      const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
      packageJson.scripts[script] = replacement;
      await writeFile(packagePath, `${JSON.stringify(packageJson)}\n`);

      assert.match((await checkGateRouting(root, { paths })).join("\n"), expected);
    });
  }
});

test("resolves direct script commands for every supported runner", async () => {
  for (const [runner, path] of [
    ["node", "scripts/x.mjs"],
    ["python", "scripts/x.py"],
    ["python3", "scripts/x.py"],
    ["bash", "scripts/x.sh"],
    ["sh", "scripts/x.sh"],
  ]) {
    const root = await fixture();
    const skillPath = join(root, ".claude/skills/push/SKILL.md");
    await writeFile(
      skillPath,
      `${await readFile(skillPath, "utf8")}\n\`\`\`bash\n${runner} ${path}\n\`\`\`\n`,
    );
    await write(root, path, "\n");
    assert.deepEqual(await checkGateRouting(root, { paths }), [], `${runner} did not resolve`);
  }
});

test("reports script-runner paths that escape scripts", async () => {
  for (const command of [
    "bash /tmp/x.sh",
    "python3 /tmp/x.py",
    "bash scripts-evil/x.sh",
    "sh scripts/../package.json",
    "python3 scripts/../package.json",
  ]) {
    const root = await fixture();
    const skillPath = join(root, ".claude/skills/push/SKILL.md");
    await writeFile(
      skillPath,
      `${await readFile(skillPath, "utf8")}\n\`\`\`bash\n${command}\n\`\`\`\n`,
    );
    assert.match(
      (await checkGateRouting(root, { paths })).join("\n"),
      new RegExp(`gate command escapes scripts/: ${command.replaceAll("/", "\\/")}`, "u"),
    );
  }
});

test("rejects an unrouted node:test file", async () => {
  const root = await fixture();
  await write(root, "scripts/orphan-tests.mjs", "\n");
  assert.match((await checkGateRouting(root, { paths })).join("\n"), /orphan-tests/u);
});

test("recognises every repository test shape and executable checkers regardless of name", async () => {
  const root = await fixture();
  for (const path of [
    "scripts/python-tests.py",
    "scripts/python_test.py",
    "scripts/shell-tests.sh",
  ]) {
    await write(root, path, "\n");
  }
  await write(root, "scripts/validate-example.mjs", "#!/usr/bin/env node\n");
  await chmod(join(root, "scripts/validate-example.mjs"), 0o755);

  const problems = (await checkGateRouting(root, { paths })).join("\n");
  assert.match(problems, /python-tests\.py/u);
  assert.match(problems, /python_test\.py/u);
  assert.match(problems, /shell-tests\.sh/u);
  assert.match(problems, /checker file scripts\/validate-example\.mjs/u);
});

test("rejects a checker without a package script", async () => {
  const root = await fixture();
  await write(root, "scripts/check-orphan.mjs", "\n");
  assert.match((await checkGateRouting(root, { paths })).join("\n"), /checker file/u);
});

test("requires a checker path to be an actual command invocation", async () => {
  const root = await fixture();
  const packagePath = join(root, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.scripts["all:check"] = "echo scripts/check-example.mjs && pnpm nested:check";
  await writeFile(packagePath, JSON.stringify(packageJson));

  assert.match(
    (await checkGateRouting(root, { paths })).join("\n"),
    /checker file scripts\/check-example\.mjs/u,
  );

  packageJson.scripts["all:check"] = "scripts/check-example.mjs && pnpm nested:check";
  await writeFile(packagePath, JSON.stringify(packageJson));
  assert.deepEqual(await checkGateRouting(root, { paths }), []);
});

test("rejects a missing package script named by a fenced gate command", async () => {
  const root = await fixture();
  const path = join(root, ".claude/skills/push/SKILL.md");
  await writeFile(
    path,
    `${await readFile(path, "utf8")}\n\`\`\`bash\npnpm does:not:exist\n\`\`\`\n`,
  );
  assert.match((await checkGateRouting(root, { paths })).join("\n"), /does:not:exist/u);
});

test("rejects a fenced gate command that is none of the accepted forms", async () => {
  // Pins the `unresolved gate command` branch: pnpm <script>, allowed cargo
  // forms, and the five supported script runners are accepted; anything else (including a
  // raw `kit …` line) must fail. Without this test, deleting that branch kept the suite green
  // while `pnpm gates:routing:check` accepted an unroutable fence.
  const root = await fixture();
  const path = join(root, ".claude/skills/push/SKILL.md");
  await writeFile(
    path,
    `${await readFile(path, "utf8")}\n\`\`\`bash\nkit sync --check .\n\`\`\`\n`,
  );
  assert.match(
    (await checkGateRouting(root, { paths })).join("\n"),
    /unresolved gate command in .claude\/skills\/push\/SKILL.md: kit sync --check \./u,
  );
});

test("resolves a fenced gate command behind the agent-gate launcher", async () => {
  // The push skill runs the installer as `agent-gate bash scripts/install-local.sh`
  // (f-20261116-03). The launcher prefix must not hide the routed script, and an
  // unroutable command behind it must still fail.
  const root = await fixture();
  // Reachable only through the fenced line, so the empty result proves the launcher
  // prefix keeps the script's route as well as its classification.
  await write(root, "scripts/check-fenced-only.mjs", "\n");
  const path = join(root, ".claude/skills/push/SKILL.md");
  const original = await readFile(path, "utf8");
  assert.match(
    (await checkGateRouting(root, { paths })).join("\n"),
    /checker file scripts\/check-fenced-only\.mjs is not reachable/u,
  );
  await writeFile(
    path,
    `${original}\n\`\`\`bash\nagent-gate bash scripts/check-fenced-only.mjs\n\`\`\`\n`,
  );
  assert.deepEqual(await checkGateRouting(root, { paths }), []);
  await writeFile(path, `${original}\n\`\`\`bash\nagent-gate kit sync --check .\n\`\`\`\n`);
  assert.match(
    (await checkGateRouting(root, { paths })).join("\n"),
    /unresolved gate command in .claude\/skills\/push\/SKILL.md: agent-gate kit sync --check \./u,
  );
});

test("rejects a missing package script reached through a nested pnpm command", async () => {
  const root = await fixture();
  const packagePath = join(root, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.scripts["nested:check"] = "pnpm missing:nested";
  await writeFile(packagePath, JSON.stringify(packageJson));
  assert.match((await checkGateRouting(root, { paths })).join("\n"), /missing:nested/u);
});

test("rejects a check or test package script absent from push and CI routing", async () => {
  const root = await fixture();
  const packagePath = join(root, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.scripts["orphan:check"] = "node scripts/orphan.mjs";
  await writeFile(packagePath, JSON.stringify(packageJson));
  assert.match((await checkGateRouting(root, { paths })).join("\n"), /orphan:check/u);
});

test("rejects a workflow-only check script", async () => {
  const root = await fixture();
  const packagePath = join(root, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.scripts["workflow-only:check"] = "node scripts/workflow-only.mjs";
  await writeFile(packagePath, JSON.stringify(packageJson));
  const workflowPath = join(root, ".github/workflows/test.yml");
  await writeFile(
    workflowPath,
    `${await readFile(workflowPath, "utf8")}  - name: Workflow only\n    run: pnpm workflow-only:check\n`,
  );
  assert.match(
    (await checkGateRouting(root, { paths })).join("\n"),
    /workflow-routed package script workflow-only:check/u,
  );
});

test("rejects a workflow-only script without a check or test suffix", async () => {
  const root = await fixture();
  const packagePath = join(root, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.scripts["example:run"] = "node scripts/example-run.mjs";
  await writeFile(packagePath, JSON.stringify(packageJson));
  const workflowPath = join(root, ".github/workflows/test.yml");
  await writeFile(
    workflowPath,
    `${await readFile(workflowPath, "utf8")}  - name: Workflow only\n    run: pnpm example:run\n`,
  );
  assert.match(
    (await checkGateRouting(root, { paths })).join("\n"),
    /workflow-routed package script example:run/u,
  );
});

test("rejects a workflow-only script reached transitively", async () => {
  const root = await fixture();
  const packagePath = join(root, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.scripts["outer:run"] = "pnpm inner:run";
  packageJson.scripts["inner:run"] = "node scripts/inner.mjs";
  await writeFile(packagePath, JSON.stringify(packageJson));
  const workflowPath = join(root, ".github/workflows/test.yml");
  await writeFile(
    workflowPath,
    `${await readFile(workflowPath, "utf8")}  - name: Workflow only\n    run: pnpm outer:run\n`,
  );
  assert.match(
    (await checkGateRouting(root, { paths })).join("\n"),
    /workflow-routed package script outer:run/u,
  );
});

test("rejects a direct workflow script command that has no push-skill route", async () => {
  const root = await fixture();
  const workflowPath = join(root, ".github/workflows/test.yml");
  await writeFile(
    workflowPath,
    `${await readFile(workflowPath, "utf8")}  - name: Direct script\n    run: node scripts/check-example.mjs --strict\n`,
  );
  assert.match(
    (await checkGateRouting(root, { paths })).join("\n"),
    /workflow command must exactly match/u,
  );
});

test("rejects an unfenced direct workflow script in a quoted run scalar", async () => {
  const root = await fixture();
  const workflowPath = join(root, ".github/workflows/test.yml");
  await writeFile(
    workflowPath,
    `${await readFile(workflowPath, "utf8")}  - name: Quoted direct script\n    run: "node scripts/check-example.mjs --strict"\n`,
  );
  assert.match(
    (await checkGateRouting(root, { paths })).join("\n"),
    /workflow command must exactly match/u,
  );
});

test("accepts a direct workflow script command fenced verbatim in the push skill", async () => {
  const root = await fixture();
  const command = "node scripts/check-example.mjs --strict";
  const workflowPath = join(root, ".github/workflows/test.yml");
  await writeFile(
    workflowPath,
    `${await readFile(workflowPath, "utf8")}  - name: Direct script\n    run: ${command}\n`,
  );
  const skillPath = join(root, ".claude/skills/push/SKILL.md");
  await writeFile(
    skillPath,
    `${await readFile(skillPath, "utf8")}\n\`\`\`bash\n${command}\n\`\`\`\n`,
  );
  assert.deepEqual(await checkGateRouting(root, { paths }), []);
});

test("accepts a quoted direct workflow script fenced verbatim in the push skill", async () => {
  const root = await fixture();
  const command = "node scripts/check-example.mjs --strict";
  const workflowPath = join(root, ".github/workflows/test.yml");
  await writeFile(
    workflowPath,
    `${await readFile(workflowPath, "utf8")}  - name: Quoted direct script\n    run: "${command}"\n`,
  );
  const skillPath = join(root, ".claude/skills/push/SKILL.md");
  await writeFile(
    skillPath,
    `${await readFile(skillPath, "utf8")}\n\`\`\`bash\n${command}\n\`\`\`\n`,
  );
  assert.deepEqual(await checkGateRouting(root, { paths }), []);
});

test("accepts a direct workflow script command inside a routed package script", async () => {
  const root = await fixture();
  const command = "node scripts/check-example.mjs --strict";
  const workflowPath = join(root, ".github/workflows/test.yml");
  await writeFile(
    workflowPath,
    `${await readFile(workflowPath, "utf8")}  - name: Direct script\n    run: ${command}\n`,
  );
  const packagePath = join(root, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.scripts["all:check"] = `${command} && pnpm nested:check`;
  await writeFile(packagePath, JSON.stringify(packageJson));
  assert.deepEqual(await checkGateRouting(root, { paths }), []);
});

test("accepts a .test.mjs file included by Vitest", async () => {
  const root = await fixture();
  await write(root, "scripts/unit.test.mjs", "\n");
  assert.deepEqual(await checkGateRouting(root, { paths }), []);
});

test("rejects a sensitive-path glob with no tracked match", async () => {
  const root = await fixture();
  assert.match((await checkGateRouting(root, { paths: [] })).join("\n"), /matches no file/u);
});

test("sensitive-path globs see untracked files through the shared walker", async () => {
  const root = await fixture();
  const skillPath = join(root, ".claude/skills/push/SKILL.md");
  const skill = await readFile(skillPath, "utf8");
  await writeFile(skillPath, skill.replace("scripts/**", "untracked-only/**"));
  await write(root, "untracked-only/secret.rs", "\n");
  assert.doesNotMatch((await checkGateRouting(root)).join("\n"), /untracked-only/u);
});

test("treats pnpm subcommands and flags as invocations, not script names", async () => {
  // `pnpm dlx shellcheck@4.1.0 ...` once resolved as a nested script named "dlx",
  // which reported a missing script that was never referenced. A leading
  // flag misparsed the same way: `pnpm -s all:check` resolved to "-s".
  const root = await fixture();
  const packagePath = join(root, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.scripts["all:check"] =
    "node scripts/check-example.mjs && pnpm nested:check && pnpm dlx shellcheck@4.1.0 x.sh && pnpm -s nested:check";
  await writeFile(packagePath, JSON.stringify(packageJson));
  const problems = (await checkGateRouting(root, { paths })).join("\n");
  assert.doesNotMatch(problems, /\bdlx\b/u);
  assert.doesNotMatch(problems, /"-s"|\s-s\b/u);
});

test("the review path-glob collector validates every path block, not just one", async () => {
  // The locator once demanded exactly one text block, which coupled "the sensitive-path
  // registry" to "the only fenced text in section 3". Adding a mandatory-lens path list
  // beside it - entirely legitimate - threw instead of checking it.
  const root = await fixture();
  const skillPath = join(root, ".claude/skills/push/SKILL.md");
  const skill = await readFile(skillPath, "utf8");
  await writeFile(
    skillPath,
    skill.replace(
      "## 4. Finish",
      "A mandatory additive lens covers:\n\n```text\nscripts/**\n```\n\n## 4. Finish",
    ),
  );
  assert.deepEqual(await checkGateRouting(root, { paths }), []);

  const withDeadGlob = (await readFile(skillPath, "utf8")).replace(
    "```text\nscripts/**\n```\n\n## 4. Finish",
    "```text\nnever/matches/**\n```\n\n## 4. Finish",
  );
  await writeFile(skillPath, withDeadGlob);
  assert.match((await checkGateRouting(root, { paths })).join("\n"), /never\/matches/u);
});

test("uses the shared coverage glob semantics for review path matching", async () => {
  const root = await fixture();
  const skillPath = join(root, ".claude/skills/push/SKILL.md");
  const skill = await readFile(skillPath, "utf8");
  await writeFile(skillPath, skill.replace("scripts/**", "**/check-*.mjs"));

  assert.deepEqual(await checkGateRouting(root, { paths }), []);
});

test("rejects a contract-gate member duplicated directly in the workflow", async () => {
  const root = await fixture();
  const workflowPath = join(root, ".github/workflows/test.yml");
  await writeFile(
    workflowPath,
    `${await readFile(workflowPath, "utf8")}  - name: Duplicate member\n    run: pnpm all:check\n`,
  );
  assert.match(
    (await checkGateRouting(root, { paths })).join("\n"),
    /contract-gate member all:check is also invoked directly by .github\/workflows\/test.yml/u,
  );
});

test("requires exactly one workflow step for the contract gate", async () => {
  const root = await fixture();
  const workflowPath = join(root, ".github/workflows/test.yml");
  await writeFile(
    workflowPath,
    `${await readFile(workflowPath, "utf8")}  - name: Contract again\n    run: pnpm gates:contract:check\n`,
  );
  assert.match(
    (await checkGateRouting(root, { paths })).join("\n"),
    /must run gates:contract:check exactly once/u,
  );
});

test("requires the contract gate package script", async () => {
  const root = await fixture();
  const packagePath = join(root, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  delete packageJson.scripts["gates:contract:check"];
  await writeFile(packagePath, JSON.stringify(packageJson));
  assert.match((await checkGateRouting(root, { paths })).join("\n"), /package.json is missing/u);
});

test("requires the workflow to run the contract gate", async () => {
  const root = await fixture();
  await write(
    root,
    ".github/workflows/test.yml",
    "steps:\n  - name: No command\n    uses: x/y@v1\n",
  );
  assert.match(
    (await checkGateRouting(root, { paths })).join("\n"),
    /must run gates:contract:check exactly once/u,
  );
});

test("requires an unconditional contract-gate workflow step", async () => {
  const root = await fixture();
  const workflowPath = join(root, ".github/workflows/test.yml");
  const workflow = await readFile(workflowPath, "utf8");
  await writeFile(workflowPath, workflow.replace("    run:", "    if: success()\n    run:"));
  assert.match(
    (await checkGateRouting(root, { paths })).join("\n"),
    /workflow step has if: "success\(\)": Contract/u,
  );
});

test("rejects if on any routed gate step but accepts if on an upload step", async () => {
  const root = await fixture();
  const workflowPath = join(root, ".github/workflows/test.yml");
  const workflow = await readFile(workflowPath, "utf8");
  await writeFile(
    workflowPath,
    `${workflow.replace(
      "    run: pnpm test:e2e:container",
      "    if: github.ref == 'refs/heads/master'\n    run: pnpm test:e2e:container",
    )}  - name: Upload\n    if: always()\n    uses: actions/upload-artifact@v4\n`,
  );
  const findings = (await checkGateRouting(root, { paths })).join("\n");
  assert.match(findings, /workflow step has if: "github\.ref == 'refs\/heads\/master'": Browser/u);
  assert.doesNotMatch(findings, /Upload/u);
});

test("rejects continue-on-error on the contract-gate workflow step", async () => {
  const root = await fixture();
  const workflowPath = join(root, ".github/workflows/test.yml");
  const workflow = await readFile(workflowPath, "utf8");
  await writeFile(
    workflowPath,
    workflow.replace(
      "    run: pnpm gates:contract:check",
      "    continue-on-error: true\n    run: pnpm gates:contract:check",
    ),
  );
  assert.match(
    (await checkGateRouting(root, { paths })).join("\n"),
    /workflow step ignores the gate's exit status with continue-on-error: "true": Contract/u,
  );
});

test("rejects continue-on-error on another routed gate step", async () => {
  const root = await fixture();
  const workflowPath = join(root, ".github/workflows/test.yml");
  const workflow = await readFile(workflowPath, "utf8");
  await writeFile(
    workflowPath,
    workflow.replace(
      "    run: pnpm test:e2e:container",
      "    continue-on-error: true\n    run: pnpm test:e2e:container",
    ),
  );
  assert.match(
    (await checkGateRouting(root, { paths })).join("\n"),
    /workflow step ignores the gate's exit status with continue-on-error: "true": Browser/u,
  );
});

test("rejects an expression-valued continue-on-error and quotes its value", async () => {
  const root = await fixture();
  const workflowPath = join(root, ".github/workflows/test.yml");
  const workflow = await readFile(workflowPath, "utf8");
  await writeFile(
    workflowPath,
    workflow.replace(
      "    run: pnpm gates:contract:check",
      "    continue-on-error: ${{ true }}\n    run: pnpm gates:contract:check",
    ),
  );
  assert.match(
    (await checkGateRouting(root, { paths })).join("\n"),
    /continue-on-error: "\$\{\{ true \}\}": Contract/u,
  );
});

for (const [property, value] of [
  ["if", "false"],
  ["continue-on-error", "true"],
]) {
  test(`rejects job-level ${property}`, async () => {
    const root = await fixture();
    const workflowPath = join(root, ".github/workflows/test.yml");
    const workflow = await readFile(workflowPath, "utf8");
    const indentedWorkflow = workflow
      .split("\n")
      .map((line) => (line ? `    ${line}` : line))
      .join("\n");
    await writeFile(
      workflowPath,
      `jobs:\n  test:\n    ${property}: ${value}\n    runs-on: ubuntu-latest\n${indentedWorkflow}`,
    );
    assert.match(
      (await checkGateRouting(root, { paths })).join("\n"),
      new RegExp(`workflow job has ${property}: "${value}": test`, "u"),
    );
  });
}

test("requires the contract workflow command to be exact", async () => {
  const root = await fixture();
  const workflowPath = join(root, ".github/workflows/test.yml");
  const workflow = await readFile(workflowPath, "utf8");
  await writeFile(
    workflowPath,
    workflow.replace("run: pnpm gates:contract:check", "run: pnpm gates:contract:check --silent"),
  );
  assert.match((await checkGateRouting(root, { paths })).join("\n"), /must be exactly/u);
});

test("rejects workflow gate exit-code neutralisation and chaining", async () => {
  for (const suffix of [" || true", "; true", " | cat"]) {
    const root = await fixture();
    const workflowPath = join(root, ".github/workflows/test.yml");
    const workflow = await readFile(workflowPath, "utf8");
    await writeFile(
      workflowPath,
      workflow.replace("run: pnpm gates:contract:check", `run: pnpm gates:contract:check${suffix}`),
    );
    assert.match(
      (await checkGateRouting(root, { paths })).join("\n"),
      /workflow step neutralises or chains gate exit codes/u,
    );
  }
});

test("rejects changed arguments on a routed workflow script", async () => {
  const root = await fixture();
  const workflowPath = join(root, ".github/workflows/test.yml");
  const workflow = await readFile(workflowPath, "utf8");
  await writeFile(
    workflowPath,
    workflow.replace(
      "run: pnpm test:e2e:container",
      "run: pnpm test:e2e:container --update-snapshots",
    ),
  );
  assert.match(
    (await checkGateRouting(root, { paths })).join("\n"),
    /workflow command must exactly match/u,
  );
});

test("accepts the exact contract workflow command", async () => {
  const root = await fixture();
  assert.doesNotMatch(
    (await checkGateRouting(root, { paths })).join("\n"),
    /contract-gate step must be exactly/u,
  );
});

test("accepts every YAML block scalar spelling and preserves folding semantics", () => {
  for (const marker of ["|", "|-", "|+", "|2", "|2-", "|+2", ">", ">-", ">+"]) {
    const [step] = workflowSteps(
      `steps:\n  - name: Scalar\n    run: ${marker}\n      pnpm alpha\n      pnpm beta\n`,
    );
    assert.equal(
      step.run,
      marker.startsWith("|") ? "pnpm alpha\npnpm beta" : "pnpm alpha pnpm beta",
    );
  }
});

test("parses job bodies and step shell metadata without depending on field order", () => {
  const [job] = workflowJobs(
    "jobs:\n  rust:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bash scripts/setup-rust.sh\n        name: Setup\n        shell: bash\n",
  );
  assert.equal(job.name, "rust");
  assert.match(job.body, /runs-on: ubuntu-latest/u);
  assert.deepEqual(workflowSteps(job.body), [
    {
      name: "Setup",
      run: "bash scripts/setup-rust.sh",
      runError: undefined,
      hasIf: false,
      ifValue: undefined,
      continueOnError: undefined,
      shell: "bash",
      timeoutMinutes: undefined,
    },
  ]);
});

test("splits step blocks including uses steps and ignores comments and nested lists", () => {
  const steps = workflowStepBlocks(
    [
      "jobs:",
      "  rust:",
      "    strategy:",
      "      matrix:",
      "        os:",
      "          - ubuntu-latest",
      "    steps:",
      "      # leading comment",
      "      - name: Restore",
      "        id: restore",
      "        if: steps.a.outputs.b != ''",
      "        continue-on-error: true",
      "        uses: actions/cache/restore@v4",
      "        with:",
      "          path: /tmp/x/*.deb",
      "          restore-keys: |",
      "            one-",
      "            two-",
      "",
      "      # between steps",
      "      - run: echo done",
      "        shell: bash",
    ].join("\n"),
  );
  assert.equal(steps.length, 2);
  assert.deepEqual(
    { ...steps[0], withValues: [...steps[0].withValues], text: undefined },
    {
      name: "Restore",
      id: "restore",
      uses: "actions/cache/restore@v4",
      ifValue: "steps.a.outputs.b != ''",
      continueOnError: "true",
      timeoutMinutes: undefined,
      withValues: [
        ["path", "/tmp/x/*.deb"],
        ["restore-keys", "|"],
      ],
      text: undefined,
    },
  );
  assert.match(steps[0].text, /one-\n\s+two-/u);
  assert.doesNotMatch(steps[0].text, /comment/u);
  assert.equal(steps[1].uses, undefined);
  assert.match(steps[1].text, /run: echo done/u);
  assert.deepEqual(workflowStepBlocks("name: composite\n"), []);
});

test("unquotes YAML run scalars and their supported escapes", () => {
  const steps = workflowSteps(
    `steps:\n  - name: Double\n    run: "node scripts/check-example.mjs \\"quoted\\" \\\\path"\n  - name: Single\n    run: 'node scripts/check-example.mjs ''quoted'''\n`,
  );
  assert.equal(steps[0].run, 'node scripts/check-example.mjs "quoted" \\path');
  assert.equal(steps[1].run, "node scripts/check-example.mjs 'quoted'");
});

test("decodes YAML control and hexadecimal escapes in run scalars", () => {
  const [step] = workflowSteps(`steps:\n  - run: "pnpm\\x20alpha\\nnext\\t\\u0041\\U0001F600"\n`);
  assert.equal(step.run, "pnpm alpha\nnext\tA😀");
  assert.equal(step.runError, undefined);
});

test("reports a CI-only script hidden by a YAML Unicode escape", async () => {
  const root = await fixture();
  const packagePath = join(root, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.scripts["ci-only:run"] = "node scripts/ci-only.mjs";
  await writeFile(packagePath, JSON.stringify(packageJson));
  const workflowPath = join(root, ".github/workflows/test.yml");
  await writeFile(
    workflowPath,
    `${await readFile(workflowPath, "utf8")}  - name: Escaped\n    run: "pnpm\\u0020ci-only:run"\n`,
  );
  assert.match(
    (await checkGateRouting(root, { paths })).join("\n"),
    /workflow-routed package script ci-only:run/u,
  );
});

test("reports unsupported YAML escapes in run scalars", async () => {
  const root = await fixture();
  const workflowPath = join(root, ".github/workflows/test.yml");
  await writeFile(
    workflowPath,
    `${await readFile(workflowPath, "utf8")}  - name: Unsupported\n    run: "pnpm \\q x"\n`,
  );
  assert.match(
    (await checkGateRouting(root, { paths })).join("\n"),
    /unsupported YAML escape in run: \\q/u,
  );
});

test("reports a Cargo workflow gate whose arguments differ from the scheduler", async () => {
  const root = await fixture();
  const workflowPath = join(root, ".github/workflows/test.yml");
  const workflow = await readFile(workflowPath, "utf8");
  await writeFile(
    workflowPath,
    workflow.replace("--all-targets --locked -- -D warnings", "--all-targets -- -D warnings"),
  );
  assert.match(
    (await checkGateRouting(root, { paths })).join("\n"),
    /workflow command must exactly match.*cargo clippy/u,
  );
});

test("accepts Cargo workflow gates with identical fenced lines", async () => {
  const root = await fixture();
  assert.doesNotMatch(
    (await checkGateRouting(root, { paths })).join("\n"),
    /workflow command must exactly match.*cargo/u,
  );
});

test("requires the P0 mutation guard to route through the contract chain (PG-61)", async () => {
  const root = await fixture();
  const packagePath = join(root, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.scripts["gates:contract:check"] = packageJson.scripts["gates:contract:check"].replace(
    "pnpm mutation:guard:check && ",
    "",
  );
  await writeFile(packagePath, JSON.stringify(packageJson));
  assert.match(
    (await checkGateRouting(root, { paths })).join("\n"),
    /gates:contract:check must run mutation:guard:check first/u,
  );
});

test("reports CI-only scripts hidden in literal and folded block scalars", async () => {
  for (const marker of ["|-", ">-"]) {
    const root = await fixture();
    const packagePath = join(root, "package.json");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
    packageJson.scripts["ci-only:run"] = "node scripts/ci-only.mjs";
    await writeFile(packagePath, JSON.stringify(packageJson));
    const workflowPath = join(root, ".github/workflows/test.yml");
    await writeFile(
      workflowPath,
      `${await readFile(workflowPath, "utf8")}  - name: Hidden\n    run: ${marker}\n      pnpm ci-only:run\n`,
    );
    assert.match(
      (await checkGateRouting(root, { paths })).join("\n"),
      /workflow-routed package script ci-only:run/u,
    );
  }
});

test("reports a CI-only script in an explicitly indented block scalar", async () => {
  const root = await fixture();
  const packagePath = join(root, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.scripts["ci-only:run"] = "node scripts/ci-only.mjs";
  await writeFile(packagePath, JSON.stringify(packageJson));
  const workflowPath = join(root, ".github/workflows/test.yml");
  await writeFile(
    workflowPath,
    `${await readFile(workflowPath, "utf8")}  - name: Explicit indentation\n    run: |2-\n      pnpm ci-only:run\n`,
  );
  assert.match(
    (await checkGateRouting(root, { paths })).join("\n"),
    /workflow-routed package script ci-only:run/u,
  );
});

test("rejects test.yml missing e2e or either coverage ratchet", async (t) => {
  for (const [label, stepText, scriptName] of [
    ["e2e", "  - name: Browser\n    run: pnpm test:e2e:container\n", "test:e2e:container"],
    [
      "frontend ratchet",
      "  - name: Frontend ratchet\n    run: pnpm coverage:frontend:check\n",
      "coverage:frontend:check",
    ],
    [
      "backend ratchet",
      "  - name: Backend ratchet\n    run: pnpm coverage:backend:check\n",
      "coverage:backend:check",
    ],
  ]) {
    await t.test(label, async () => {
      const root = await fixture();
      const workflowPath = join(root, ".github/workflows/test.yml");
      const workflow = await readFile(workflowPath, "utf8");
      assert.ok(workflow.includes(stepText));
      await writeFile(workflowPath, workflow.replace(stepText, ""));
      assert.match(
        (await checkGateRouting(root, { paths })).join("\n"),
        new RegExp(`CI_REQUIRED_SCRIPTS key ${scriptName} is absent`, "u"),
      );
    });
  }
});

test("rejects re-adding per-push frontend mutation to test.yml and accepts CI-only commands only through the named set", async (t) => {
  await t.test("re-added pnpm mutation:frontend is rejected", async () => {
    const root = await fixture();
    const packagePath = join(root, "package.json");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
    packageJson.scripts["mutation:frontend"] = "node scripts/run-frontend-mutation.mjs";
    await writeFile(packagePath, JSON.stringify(packageJson));
    const workflowPath = join(root, ".github/workflows/test.yml");
    await writeFile(
      workflowPath,
      `${await readFile(workflowPath, "utf8")}  - name: Mutation\n    run: pnpm mutation:frontend\n`,
    );
    assert.match(
      (await checkGateRouting(root, { paths })).join("\n"),
      /workflow-routed package script mutation:frontend is absent from the push gate scheduler/u,
    );
  });

  await t.test("unlisted CI-only cargo test variant is rejected", async () => {
    const root = await fixture();
    const workflowPath = join(root, ".github/workflows/test.yml");
    await writeFile(
      workflowPath,
      `${await readFile(workflowPath, "utf8")}  - name: Unlisted cargo test\n    run: cargo test --manifest-path src-tauri/Cargo.toml --bins\n`,
    );
    assert.match(
      (await checkGateRouting(root, { paths })).join("\n"),
      /workflow command must exactly match.*cargo test --manifest-path src-tauri\/Cargo\.toml --bins/u,
    );
  });

  await t.test("exact CI-only cargo nextest command is accepted", async () => {
    const root = await fixture();
    const workflowPath = join(root, ".github/workflows/test.yml");
    await writeFile(
      workflowPath,
      `${await readFile(workflowPath, "utf8")}  - name: Rust Windows tests\n    run: cargo nextest run --manifest-path src-tauri/Cargo.toml --all-targets --profile ci\n`,
    );
    assert.deepEqual(await checkGateRouting(root, { paths }), []);
  });

  await t.test("unlisted cargo nextest variant is rejected", async () => {
    const root = await fixture();
    const workflowPath = join(root, ".github/workflows/test.yml");
    await writeFile(
      workflowPath,
      `${await readFile(workflowPath, "utf8")}  - name: Unlisted cargo nextest\n    run: cargo nextest run --manifest-path src-tauri/Cargo.toml --all-targets\n`,
    );
    assert.match(
      (await checkGateRouting(root, { paths })).join("\n"),
      /workflow command must exactly match.*cargo nextest run --manifest-path src-tauri\/Cargo\.toml --all-targets/u,
    );
  });

  await t.test("if: on a cargo nextest step is rejected", async () => {
    const root = await fixture();
    const workflowPath = join(root, ".github/workflows/test.yml");
    await writeFile(
      workflowPath,
      `${await readFile(workflowPath, "utf8")}  - name: Conditional cargo nextest\n    if: runner.os == 'Windows'\n    run: cargo nextest run --manifest-path src-tauri/Cargo.toml --all-targets --profile ci\n`,
    );
    assert.match(
      (await checkGateRouting(root, { paths })).join("\n"),
      /workflow step has if: "runner\.os == 'Windows'": Conditional cargo nextest/u,
    );
  });

  await t.test("continue-on-error: on a cargo nextest step is rejected", async () => {
    const root = await fixture();
    const workflowPath = join(root, ".github/workflows/test.yml");
    await writeFile(
      workflowPath,
      `${await readFile(workflowPath, "utf8")}  - name: Ignored cargo nextest\n    continue-on-error: true\n    run: cargo nextest run --manifest-path src-tauri/Cargo.toml --all-targets --profile ci\n`,
    );
    assert.match(
      (await checkGateRouting(root, { paths })).join("\n"),
      /workflow step ignores the gate's exit status with continue-on-error: "true": Ignored cargo nextest/u,
    );
  });
});

test("the live repository pins one shared contract-gate list", async () => {
  const [packageText, workflow] = await Promise.all([
    readFile(join(projectRoot, "package.json"), "utf8"),
    readFile(join(projectRoot, ".github/workflows/test.yml"), "utf8"),
  ]);
  const scripts = JSON.parse(packageText).scripts;
  assert.equal(scripts["gates:contract:check"], CONTRACT_CHAIN);

  const steps = workflowSteps(workflow);
  const contractSteps = steps.filter((step) =>
    pnpmReferences(step.run).includes("gates:contract:check"),
  );
  assert.equal(contractSteps.length, 1);
  assert.equal(contractSteps[0].hasIf, false);
  const members = pnpmReferences(CONTRACT_CHAIN);
  assert.deepEqual(
    steps.flatMap((step) => pnpmReferences(step.run)).filter((name) => members.includes(name)),
    [],
  );
});

test("headings, section homes and repeated command examples do not affect routing", async () => {
  const root = await fixture();
  const skillPath = join(root, ".claude/skills/push/SKILL.md");
  const skill = await readFile(skillPath, "utf8");
  await writeFile(
    skillPath,
    skill.replace(/^#{2,3} .+$/gmu, "Procedure") + "\n```bash\npnpm gates:contract:check\n```\n",
  );
  assert.deepEqual(await checkGateRouting(root, { paths }), []);
});

test("executable schedules preserve routes when skill command examples are removed", async () => {
  const root = await fixture();
  const skillPath = join(root, ".claude/skills/push/SKILL.md");
  const skill = await readFile(skillPath, "utf8");
  await writeFile(skillPath, skill.replace(/^```bash\n[\s\S]*?^```\n/gmu, ""));
  assert.deepEqual(await checkGateRouting(root, { paths }), []);
});

test("detects missing scripts used by both executable schedules", async (t) => {
  for (const name of ["rust:windows:check", "coverage:mapping:frontend"]) {
    await t.test(name, async () => {
      const root = await fixture();
      const packagePath = join(root, "package.json");
      const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
      delete packageJson.scripts[name];
      await writeFile(packagePath, JSON.stringify(packageJson));
      const skillPath = join(root, ".claude/skills/push/SKILL.md");
      await writeFile(skillPath, "```text\nscripts/**\n```\n");
      assert.match(
        (await checkGateRouting(root, { paths })).join("\n"),
        new RegExp(`gate scheduler invokes missing package script ${name}`, "u"),
      );
    });
  }
});

const depsManifestName = "linux-desktop-deps-manifest.txt";

// Keep these contracts in gates:routing:test, which gates:contract:check already runs.
function ciWorkflowContracts(texts) {
  const jobs = (source) => new Map(workflowJobs(source).map((job) => [job.name, job.body]));
  const testJobs = jobs(texts.test);
  const sweepJobs = jobs(texts.sweep);
  const contracts = [];
  const requireText = (label, source, value) =>
    contracts.push([label, () => assert.ok(source?.includes(value), label)]);
  const forbid = (label, source, pattern) =>
    contracts.push([label, () => assert.doesNotMatch(source, pattern, label)]);
  contracts.push([
    "test has no frontend-mutation-packages job",
    () =>
      assert.equal(
        testJobs.has("frontend-mutation-packages"),
        false,
        "test has no frontend-mutation-packages job",
      ),
  ]);
  contracts.push([
    "test has no frontend-mutation job",
    () =>
      assert.equal(testJobs.has("frontend-mutation"), false, "test has no frontend-mutation job"),
  ]);
  // The pinned actionlint and cargo-nextest binaries are the two permitted actions/cache
  // exceptions in test.yml (d-20261127-10, superseding d-20261108-12), matched by exact path.
  forbid(
    "no push save or combined cache",
    texts.test,
    /uses:\s*["']?actions\/cache(?:\/save)?@[^\n]*\n(?!\s+with:\n\s+path: (?:~\/\.github-actionlint\/bin|~\/\.cargo\/bin\/cargo-nextest\.exe)\n)/u,
  );
  const listing = sweepJobs.get("frontend-mutation-packages");
  const sweep = sweepJobs.get("frontend-mutation");
  requireText(
    "sweep listing command",
    listing,
    'run: echo "ids=$(node scripts/run-frontend-mutation.mjs --list-packages)" >> "$GITHUB_OUTPUT"',
  );
  requireText("sweep listing output", listing, "ids: ${{ steps.list.outputs.ids }}");
  requireText("sweep listing id", listing, "id: list");
  for (const value of [
    "needs: frontend-mutation-packages",
    "fail-fast: false",
    "package: ${{ fromJSON(needs.frontend-mutation-packages.outputs.ids) }}",
    "FRONTEND_MUTATION_PACKAGE: ${{ matrix.package }}",
    "FRONTEND_MUTATION_INCREMENTAL_DIR: .frontend-mutation-incremental",
    "uses: actions/checkout@v4\n        with:\n          fetch-depth: 0",
    "run: pnpm mutation:frontend",
    "name: frontend-mutation-${{ matrix.package }}",
    "path: artifacts/mutation/frontend/${{ matrix.package }}/",
    "name: frontend-mutation-baseline-${{ matrix.package }}",
    "path: .frontend-mutation-incremental/${{ matrix.package }}.json",
  ])
    requireText(`sweep ${value}`, sweep, value);
  requireText("force full sweep", sweep, 'FRONTEND_MUTATION_FORCE: "1"');
  forbid("no sweep change base", sweep, /FRONTEND_MUTATION_CHANGED_SINCE/u);
  forbid("no sweep cache step", sweep, /uses:\s*["']?actions\/cache(?:\/(?:save|restore))?@/u);
  forbid("no sweep cache dates step", sweep, /\bid:\s*dates\b/u);
  requireText(
    "success-only baseline artifact",
    sweep,
    "if: success()\n        uses: actions/upload-artifact@v4",
  );
  requireText("daily cron", texts.sweep, '- cron: "17 2 * * *"');
  for (const name of ["frontend-mutation-packages", "frontend-mutation"])
    requireText(
      `${name} daily guard`,
      sweepJobs.get(name),
      "if: github.event_name == 'workflow_dispatch' || github.event.schedule == '17 2 * * *'",
    );
  for (const name of ["packages", "backend"])
    requireText(
      `${name} weekly guard`,
      sweepJobs.get(name),
      "if: github.event_name == 'workflow_dispatch' || github.event.schedule == '17 3 * * 0'",
    );
  const rust = testJobs.get("rust");
  contracts.push([
    "dist before cargo",
    () => {
      const commands = workflowSteps(rust).map((step) => step.run);
      const dist = commands.indexOf("mkdir -p dist");
      assert.ok(dist >= 0 && dist < commands.findIndex((command) => command.startsWith("cargo ")));
    },
  ]);
  const frontend = testJobs.get("frontend");
  contracts.push([
    "build before bindings and bundle",
    () => {
      const commands = workflowSteps(frontend).map((step) => step.run);
      const build = commands.indexOf("pnpm build-vite");
      assert.ok(
        build >= 0 &&
          build < commands.indexOf("pnpm bindings:check") &&
          build < commands.indexOf("pnpm bundle:check"),
      );
    },
  ]);
  for (const name of ["frontend", "e2e", "rust"]) {
    const body = testJobs.get(name);
    requireText(`${name} shared setup`, body, "uses: ./.github/actions/setup-ci");
    contracts.push([
      `${name} checkout before local action`,
      () =>
        assert.ok(
          body.indexOf("uses: actions/checkout@v4") <
            body.indexOf("uses: ./.github/actions/setup-ci"),
        ),
    ]);
  }
  forbid("composite has no checkout", texts.action, /actions\/checkout/u);
  for (const value of [
    "astral-sh/setup-uv@",
    "pnpm/action-setup@v4",
    "actions/setup-node@v4",
    'cache: "pnpm"',
    "pnpm install --frozen-lockfile",
    "if: inputs.desktop == 'true'",
  ])
    requireText(`composite ${value}`, texts.action, value);

  // linux-desktop-deps: one shared install, wired into every desktop consumer.
  const blocksOf = (source) => workflowStepBlocks(source ?? "");
  const pinStep = (label, steps, match, check) =>
    contracts.push([
      label,
      () => {
        const step = steps.find(match);
        assert.ok(step, label);
        check(step);
      },
    ]);
  const depsUses = "./.github/actions/linux-desktop-deps";
  const callsDeps = (step) => step.uses === depsUses;
  pinStep(
    "rust passes desktop-timeout-minutes 18",
    blocksOf(rust),
    (step) => step.uses === "./.github/actions/setup-ci",
    (step) =>
      assert.equal(
        step.withValues.get("desktop-timeout-minutes"),
        '"18"',
        "rust passes desktop-timeout-minutes 18",
      ),
  );
  const setupSteps = blocksOf(texts.action);
  pinStep(
    "setup-ci calls linux-desktop-deps under the desktop condition",
    setupSteps,
    callsDeps,
    (step) =>
      assert.equal(
        step.ifValue,
        "inputs.desktop == 'true'",
        "setup-ci calls linux-desktop-deps under the desktop condition",
      ),
  );
  pinStep("setup-ci forwards desktop-timeout-minutes", setupSteps, callsDeps, (step) =>
    assert.equal(
      step.withValues.get("timeout-minutes"),
      "${{ inputs.desktop-timeout-minutes }}",
      "setup-ci forwards desktop-timeout-minutes",
    ),
  );
  const backend = sweepJobs.get("backend");
  pinStep("mutation backend calls linux-desktop-deps", blocksOf(backend), callsDeps, () => {});
  const catalog = jobs(texts.catalog).get("native");
  pinStep(
    "catalog-engines Linux leg calls linux-desktop-deps under runner.os == 'Linux'",
    blocksOf(catalog),
    callsDeps,
    (step) =>
      assert.equal(
        step.ifValue,
        "runner.os == 'Linux'",
        "catalog-engines Linux leg calls linux-desktop-deps under runner.os == 'Linux'",
      ),
  );
  for (const [label, body] of [
    ["mutation backend", backend],
    ["catalog-engines", catalog],
  ])
    contracts.push([
      `${label} checks out before linux-desktop-deps`,
      () =>
        assert.ok(
          body.indexOf("uses: actions/checkout@v4") >= 0 &&
            body.indexOf("uses: actions/checkout@v4") < body.indexOf(`uses: ${depsUses}`),
          `${label} checks out before linux-desktop-deps`,
        ),
    ]);
  contracts.push([
    "catalog-engines path filters cover linux-desktop-deps",
    () =>
      assert.equal(
        texts.catalog.split('      - ".github/actions/linux-desktop-deps/**"\n').length - 1,
        2,
        "catalog-engines path filters cover linux-desktop-deps",
      ),
  ]);
  forbid("setup-ci keeps no inline desktop package list", texts.action, /libwebkit2gtk-4\.1-dev/u);
  forbid("mutation keeps no inline desktop package list", texts.sweep, /libwebkit2gtk-4\.1-dev/u);
  forbid(
    "catalog-engines keeps no inline desktop package list",
    texts.catalog,
    /libwebkit2gtk-4\.1-dev/u,
  );

  const depsSteps = blocksOf(texts.deps);
  const depsStep = (id) => depsSteps.find((step) => step.id === id);
  const pinDepsStep = (label, id, check) =>
    pinStep(label, depsSteps, (step) => step.id === id, check);
  const cachePathBody = (step) =>
    /\n        path: \|\n(?<body>(?:          [^\n]+\n)+)/u.exec(step?.text ?? "")?.groups.body;
  const depsText = depsSteps.map((step) => step.text).join("\n");
  // The one shell source of the archive directory: a single assignment, in the resolve step. The
  // cache `path:` literals and every `Dir::Cache::Archives` option must agree with it.
  const archiveAssignments = [...depsText.matchAll(/^ *archives=(\S+)$/gmu)];
  const archives =
    archiveAssignments.length === 1 &&
    depsStep("resolve")?.text.includes(`\n        archives=${archiveAssignments[0][1]}\n`)
      ? archiveAssignments[0][1]
      : undefined;
  const expectedCachePathBody = archives
    ? `          ${archives}/*.deb\n          ${archives}/${depsManifestName}\n`
    : undefined;
  for (const [name, id, uses] of [
    ["restore", "restore", "actions/cache/restore@v4"],
    ["save", "save", "actions/cache/save@v4"],
  ]) {
    pinDepsStep(`deps ${name} uses ${uses}`, id, (step) =>
      assert.equal(step.uses, uses, `deps ${name} uses ${uses}`),
    );
    pinDepsStep(`deps ${name} continues on error`, id, (step) =>
      assert.equal(step.continueOnError, "true", `deps ${name} continues on error`),
    );
  }
  pinDepsStep("deps restore runs only with a key", "restore", (step) =>
    assert.equal(
      step.ifValue,
      "steps.resolve.outputs.save-key != ''",
      "deps restore runs only with a key",
    ),
  );
  // The literal `== 'true'` forms: a loosened `!= 'false'` treats a missing output as true.
  for (const [label, term] of [
    ["deps save needs a key", "steps.resolve.outputs.save-key != ''"],
    ["deps save needs fetched == 'true'", "steps.download.outputs.fetched == 'true'"],
    ["deps save needs prune ok == 'true'", "steps.prune.outputs.ok == 'true'"],
  ])
    pinDepsStep(label, "save", (step) =>
      assert.ok(step.ifValue?.split(" && ").includes(term), label),
    );
  contracts.push([
    "deps has one shell source of the archive directory",
    () =>
      assert.ok(
        archives && /^\/tmp\/[\w./-]+$/u.test(archives),
        "deps has one shell source of the archive directory",
      ),
  ]);
  contracts.push([
    "deps cache paths are the archive directory's .deb files and the manifest",
    () =>
      assert.equal(
        cachePathBody(depsStep("restore")),
        expectedCachePathBody,
        "deps cache paths are the archive directory's .deb files and the manifest",
      ),
  ]);
  pinDepsStep("deps restore and save share one cache path", "save", (step) =>
    assert.equal(
      cachePathBody(step),
      cachePathBody(depsStep("restore")),
      "deps restore and save share one cache path",
    ),
  );
  // Every later shell step reads the directory from the sourced library, never from its own copy.
  // The executed resolve test pins what the library carries.
  for (const id of ["verify", "download", "prune", "install"])
    pinDepsStep(`deps ${id} sources the library`, id, (step) =>
      assert.ok(
        step.text.includes('source "$RUNNER_TEMP/linux-desktop-deps-lib.sh" || exit 1'),
        `deps ${id} sources the library`,
      ),
    );
  contracts.push([
    "deps every Dir::Cache::Archives option uses the archive directory source",
    () =>
      assert.ok(
        depsText.split('"Dir::Cache::Archives=$archives"').length - 1 === 4 &&
          depsText.split("Dir::Cache::Archives").length ===
            depsText.split('"Dir::Cache::Archives=$archives"').length,
        "deps every Dir::Cache::Archives option uses the archive directory source",
      ),
  ]);
  for (const [label, id, needle] of [
    ["deps resolve passes the cache path directory to apt", "resolve", "install --print-uris"],
    ["deps download passes the cache path directory to apt", "download", "install --download-only"],
  ])
    pinDepsStep(label, id, (step) =>
      assert.ok(step.text.includes(`-o "Dir::Cache::Archives=$archives" ${needle}`), label),
    );
  pinDepsStep(
    "deps install success path passes the cache path directory to apt",
    "install",
    (step) =>
      assert.ok(
        step.text.includes(
          'sudo apt-get -o "Dir::Cache::Archives=$archives" install --no-download --no-install-recommends -y "${packages[@]}"\n          exit $?',
        ),
        "deps install success path passes the cache path directory to apt",
      ),
  );
  pinDepsStep("deps install fallback passes the cache path directory to apt", "install", (step) =>
    assert.ok(
      step.text.includes(
        'sudo apt-get -o "Dir::Cache::Archives=$archives" install --no-download --no-install-recommends -y "${packages[@]}" "${pins[@]}"',
      ),
      "deps install fallback passes the cache path directory to apt",
    ),
  );
  // The cache population chain: verify and prune exist, their producers feed the save guard, and
  // restore and save agree on the keys.
  pinDepsStep("deps has a verify step", "verify", () => {});
  // The file-check helper lives in the library the resolve step writes. Verify keeps the per-file
  // drop and the discard-all; the helper holds the checksum-type dispatch and the comparisons.
  for (const [label, needle] of [
    ["deps check helper dispatches on the checksum type", 'case "${checksum%%:*}" in'],
    ["deps check helper handles MD5Sum", "MD5Sum) tool=md5sum ;;"],
    ["deps check helper handles SHA256", "SHA256) tool=sha256sum ;;"],
    [
      "deps check helper rejects a size mismatch",
      'if [ "$actual_size" != "$size" ]; then\n            reason="size $actual_size, expected $size"\n            return 1',
    ],
    [
      "deps check helper rejects a checksum mismatch",
      'if [ "$digest" != "${checksum#*:}" ]; then\n            reason="${checksum%%:*} $digest, expected ${checksum#*:}"\n            return 1',
    ],
  ])
    pinDepsStep(label, "resolve", (step) => assert.ok(step.text.includes(needle), label));
  pinDepsStep("deps library carries the manifest path", "resolve", (step) =>
    assert.ok(
      step.text.includes("declare -p packages archives manifest;") &&
        archives !== undefined &&
        step.text.includes(`\n        manifest=${archives}/${depsManifestName}\n`),
      "deps library carries the manifest path",
    ),
  );
  pinDepsStep("deps library writes the file-check helper", "resolve", (step) =>
    assert.ok(
      step.text.includes(
        "declare -f desktop_deps_label_stall desktop_deps_apt desktop_deps_check_file;",
      ),
      "deps library writes the file-check helper",
    ),
  );
  pinDepsStep("deps verify uses the file-check helper", "verify", (step) =>
    assert.ok(
      step.text.includes(
        'desktop_deps_check_file "$file" "$size" "$checksum" && status=0 || status=$?',
      ),
      "deps verify uses the file-check helper",
    ),
  );
  pinDepsStep("deps verify drops a restored file that fails the check", "verify", (step) =>
    assert.ok(
      step.text.includes(
        '            elif [ "$status" -eq 1 ]; then\n              echo "linux-desktop-deps: dropping restored $name: $reason"\n              rm -f -- "$file"',
      ),
      "deps verify drops a restored file that fails the check",
    ),
  );
  pinDepsStep("deps verify discards every file on a verification error", "verify", (step) =>
    assert.ok(
      step.text.includes("find \"$archives\" -maxdepth 1 -name '*.deb' -delete"),
      "deps verify discards every file on a verification error",
    ),
  );
  pinDepsStep("deps download continues on error", "download", (step) =>
    assert.equal(step.continueOnError, "true", "deps download continues on error"),
  );
  pinDepsStep("deps prune runs only after a successful download", "prune", (step) =>
    assert.equal(
      step.ifValue,
      "steps.download.outcome == 'success'",
      "deps prune runs only after a successful download",
    ),
  );
  pinDepsStep("deps prune writes the manifest", "prune", (step) =>
    assert.ok(
      step.text.includes('if prune_unneeded && cp -- "$set_file" "$manifest"; then'),
      "deps prune writes the manifest",
    ),
  );
  pinDepsStep("deps install maps the download outcome", "install", (step) =>
    assert.ok(
      step.text.includes(
        "      env:\n        DOWNLOAD_OUTCOME: ${{ steps.download.outcome }}\n      run:",
      ),
      "deps install maps the download outcome",
    ),
  );
  pinDepsStep("deps install fallback uses the file-check helper", "install", (step) =>
    assert.ok(
      step.text.includes('if ! desktop_deps_check_file "$file" "$size" "$checksum"; then'),
      "deps install fallback uses the file-check helper",
    ),
  );
  pinDepsStep("deps has a prune step", "prune", () => {});
  pinDepsStep("deps download emits fetched=true", "download", (step) =>
    assert.ok(
      step.text.includes('echo "fetched=true" >> "$GITHUB_OUTPUT"'),
      "deps download emits fetched=true",
    ),
  );
  pinDepsStep("deps prune emits ok=true", "prune", (step) =>
    assert.ok(step.text.includes('echo "ok=true" >> "$GITHUB_OUTPUT"'), "deps prune emits ok=true"),
  );
  pinDepsStep("deps restore key is the save key", "restore", (step) =>
    assert.equal(
      step.withValues.get("key"),
      "${{ steps.resolve.outputs.save-key }}",
      "deps restore key is the save key",
    ),
  );
  pinDepsStep("deps restore-keys are the set and bare prefixes", "restore", (step) =>
    assert.ok(
      step.text.includes(
        "restore-keys: |\n          ${{ steps.resolve.outputs.set-prefix }}\n          ${{ steps.resolve.outputs.bare-prefix }}\n",
      ),
      "deps restore-keys are the set and bare prefixes",
    ),
  );
  pinDepsStep("deps save key is the save key", "save", (step) =>
    assert.equal(
      step.withValues.get("key"),
      "${{ steps.resolve.outputs.save-key }}",
      "deps save key is the save key",
    ),
  );
  contracts.push([
    "deps steps run in the documented order",
    () =>
      assert.deepEqual(
        depsSteps.map((step) => step.id),
        ["resolve", "restore", "verify", "download", "prune", "save", "install"],
        "deps steps run in the documented order",
      ),
  ]);
  // Wiring: the input reaches the resolve step, and both apt call sites go through the helper. The
  // bound, deadline and export logic is run by the executed helper and resolve tests.
  pinDepsStep("deps resolve maps timeout-minutes to TIMEOUT_MINUTES", "resolve", (step) =>
    assert.ok(
      step.text.includes(
        "      env:\n        TIMEOUT_MINUTES: ${{ inputs.timeout-minutes }}\n      run:",
      ),
      "deps resolve maps timeout-minutes to TIMEOUT_MINUTES",
    ),
  );
  pinDepsStep("deps update goes through desktop_deps_apt", "resolve", (step) =>
    assert.ok(
      step.text.includes("\n        desktop_deps_apt update update || exit $?\n"),
      "deps update goes through desktop_deps_apt",
    ),
  );
  pinDepsStep("deps download goes through desktop_deps_apt", "download", (step) =>
    assert.ok(
      step.text.includes('\n        desktop_deps_apt download "${download_args[@]}" || exit $?\n'),
      "deps download goes through desktop_deps_apt",
    ),
  );
  contracts.push([
    "deps has a single sudo timeout --kill-after form",
    () =>
      assert.equal(
        depsSteps
          .map((step) => step.text)
          .join("\n")
          .split("sudo timeout --kill-after=").length - 1,
        1,
        "deps has a single sudo timeout --kill-after form",
      ),
  ]);
  pinDepsStep("deps install uses --no-download", "install", (step) =>
    assert.match(step.text, /install --no-download /u, "deps install uses --no-download"),
  );
  return contracts;
}

// Shared mutation-harness mechanics. `failingNames` runs [name, check] entries and returns the
// names whose check throws; `assertMutationRed` applies a mutation, refuses one that changed
// nothing, and asserts that the expected entry (or any entry, when none is named) turns red.
function failingNames(entries) {
  return entries.flatMap(([name, check]) => {
    try {
      check();
      return [];
    } catch {
      return [name];
    }
  });
}

function assertMutationRed({ original, mutate, failedFor, expected, report = () => {} }) {
  const mutated = mutate(original);
  assert.notDeepEqual(mutated, original, "the mutation changed nothing");
  const failed = failedFor(mutated);
  report(failed);
  if (expected) assert.ok(failed.includes(expected), `${expected} stayed green: ${failed}`);
  else assert.ok(failed.length > 0);
}

// Names of the contracts that fail for the given workflow texts.
function failedContracts(texts) {
  return failingNames(ciWorkflowContracts(texts));
}

async function readCiWorkflowTexts() {
  const [test, sweep, action, deps, catalog] = await Promise.all([
    readFile(join(projectRoot, ".github/workflows/test.yml"), "utf8"),
    readFile(join(projectRoot, ".github/workflows/mutation.yml"), "utf8"),
    readFile(join(projectRoot, ".github/actions/setup-ci/action.yml"), "utf8"),
    readFile(join(projectRoot, ".github/actions/linux-desktop-deps/action.yml"), "utf8"),
    readFile(join(projectRoot, ".github/workflows/catalog-engines.yml"), "utf8"),
  ]);
  return { test, sweep, action, deps, catalog };
}

test("CI workflow wiring preserves parallel gates and bounded incremental reuse", async () => {
  const texts = await readCiWorkflowTexts();
  for (const [, check] of ciWorkflowContracts(texts)) check();
  const listed = spawnSync(
    process.execPath,
    ["scripts/run-frontend-mutation.mjs", "--list-packages"],
    { cwd: projectRoot, encoding: "utf8" },
  );
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout), Object.keys(mutationPackages));
});

const depsCall = "uses: ./.github/actions/linux-desktop-deps";
const depsArchives = "/tmp/linux-desktop-apt-archives";
const depsCachePathBlock = `        path: |\n          ${depsArchives}/*.deb\n          ${depsArchives}/${depsManifestName}\n`;
const depsSaveStepFragment = `${depsCachePathBlock}        key: ${"$"}{{ steps.resolve.outputs.save-key }}\n\n`;
const depsRestoreStepFragment = `${depsCachePathBlock}        key: ${"$"}{{ steps.resolve.outputs.save-key }}\n        restore-keys`;
// [label, file, before (a string or a global RegExp), after, contract that must turn red]
const linuxDesktopDepsRows = [
  [
    "rust bound emptied",
    "test",
    'desktop-timeout-minutes: "18"',
    'desktop-timeout-minutes: ""',
    "rust passes desktop-timeout-minutes 18",
  ],
  [
    "rust bound removed",
    "test",
    '          desktop-timeout-minutes: "18"\n',
    "",
    "rust passes desktop-timeout-minutes 18",
  ],
  [
    "setup-ci timeout not forwarded",
    "action",
    "timeout-minutes: ${{ inputs.desktop-timeout-minutes }}",
    'timeout-minutes: ""',
    "setup-ci forwards desktop-timeout-minutes",
  ],
  [
    "setup-ci desktop condition loosened",
    "action",
    "      if: inputs.desktop == 'true'\n      uses",
    "      if: inputs.desktop != 'false'\n      uses",
    "setup-ci calls linux-desktop-deps under the desktop condition",
  ],
  [
    "setup-ci call replaced by an inline install",
    "action",
    depsCall,
    "run: sudo apt-get install -y libwebkit2gtk-4.1-dev",
    "setup-ci calls linux-desktop-deps under the desktop condition",
  ],
  [
    "setup-ci package list restored",
    "action",
    depsCall,
    `${depsCall}\n      env:\n        PACKAGES: libwebkit2gtk-4.1-dev`,
    "setup-ci keeps no inline desktop package list",
  ],
  [
    "mutation backend call removed",
    "sweep",
    depsCall,
    "run: echo skipped",
    "mutation backend calls linux-desktop-deps",
  ],
  [
    "mutation package list restored",
    "sweep",
    depsCall,
    `${depsCall}\n        env:\n          PACKAGES: libwebkit2gtk-4.1-dev`,
    "mutation keeps no inline desktop package list",
  ],
  [
    "catalog-engines call removed",
    "catalog",
    depsCall,
    "run: echo skipped",
    "catalog-engines Linux leg calls linux-desktop-deps under runner.os == 'Linux'",
  ],
  [
    "catalog-engines Linux guard removed",
    "catalog",
    `        if: runner.os == 'Linux'\n        ${depsCall}`,
    `        ${depsCall}`,
    "catalog-engines Linux leg calls linux-desktop-deps under runner.os == 'Linux'",
  ],
  [
    "catalog-engines path filters lose the action",
    "catalog",
    '      - ".github/actions/linux-desktop-deps/**"\n',
    "",
    "catalog-engines path filters cover linux-desktop-deps",
  ],
  [
    "catalog-engines package list restored",
    "catalog",
    depsCall,
    `${depsCall}\n        env:\n          PACKAGES: libwebkit2gtk-4.1-dev`,
    "catalog-engines keeps no inline desktop package list",
  ],
  [
    "restore continue-on-error removed",
    "deps",
    "      continue-on-error: true\n      uses: actions/cache/restore@v4",
    "      uses: actions/cache/restore@v4",
    "deps restore continues on error",
  ],
  [
    "save continue-on-error removed",
    "deps",
    "      continue-on-error: true\n      uses: actions/cache/save@v4",
    "      uses: actions/cache/save@v4",
    "deps save continues on error",
  ],
  [
    "restore key guard removed",
    "deps",
    "      id: restore\n      if: steps.resolve.outputs.save-key != ''\n",
    "      id: restore\n",
    "deps restore runs only with a key",
  ],
  [
    "save key guard removed",
    "deps",
    "steps.resolve.outputs.save-key != '' && steps.download",
    "steps.download",
    "deps save needs a key",
  ],
  [
    "save fetched guard loosened",
    "deps",
    "steps.download.outputs.fetched == 'true'",
    "steps.download.outputs.fetched != 'false'",
    "deps save needs fetched == 'true'",
  ],
  [
    "save prune guard loosened",
    "deps",
    "steps.prune.outputs.ok == 'true'",
    "steps.prune.outputs.ok != 'false'",
    "deps save needs prune ok == 'true'",
  ],
  [
    "save path becomes the directory",
    "deps",
    depsSaveStepFragment,
    depsSaveStepFragment.replace("/*.deb", ""),
    "deps restore and save share one cache path",
  ],
  [
    "restore path becomes the directory",
    "deps",
    depsRestoreStepFragment,
    depsRestoreStepFragment.replace("/*.deb", ""),
    "deps cache paths are the archive directory's .deb files and the manifest",
  ],
  [
    "resolve loses the archive directory",
    "deps",
    'apt-get -o "Dir::Cache::Archives=$archives" install --print-uris',
    "apt-get install --print-uris",
    "deps resolve passes the cache path directory to apt",
  ],
  [
    "download uses another archive directory",
    "deps",
    'download_args=(-o "Dir::Cache::Archives=$archives"',
    "download_args=(-o Dir::Cache::Archives=/tmp/other-archives",
    "deps download passes the cache path directory to apt",
  ],
  [
    "success install loses the archive directory",
    "deps",
    'sudo apt-get -o "Dir::Cache::Archives=$archives" install --no-download --no-install-recommends -y "${packages[@]}"\n          exit $?',
    'sudo apt-get install --no-download --no-install-recommends -y "${packages[@]}"\n          exit $?',
    "deps install success path passes the cache path directory to apt",
  ],
  [
    "fallback install loses the archive directory",
    "deps",
    'sudo apt-get -o "Dir::Cache::Archives=$archives" install --no-download --no-install-recommends -y "${packages[@]}" "${pins[@]}"',
    'sudo apt-get install --no-download --no-install-recommends -y "${packages[@]}" "${pins[@]}"',
    "deps install fallback passes the cache path directory to apt",
  ],
  [
    "download passes a literal archive directory",
    "deps",
    'download_args=(-o "Dir::Cache::Archives=$archives"',
    `download_args=(-o Dir::Cache::Archives=${depsArchives}`,
    "deps every Dir::Cache::Archives option uses the archive directory source",
  ],
  [
    "resolve archive directory drifts",
    "deps",
    `archives=${depsArchives}\n`,
    "archives=/tmp/other-archives\n",
    "deps cache paths are the archive directory's .deb files and the manifest",
  ],
  [
    "save path drifts from the archive directory",
    "deps",
    depsSaveStepFragment,
    depsSaveStepFragment.replace(depsArchives, "/tmp/other-archives"),
    "deps restore and save share one cache path",
  ],
  [
    "restore path drifts from the archive directory",
    "deps",
    depsRestoreStepFragment,
    depsRestoreStepFragment.replace(depsArchives, "/tmp/other-archives"),
    "deps cache paths are the archive directory's .deb files and the manifest",
  ],
  [
    "verify assigns its own archive directory",
    "deps",
    '        reason=""\n        verify_restored() {',
    '        archives=/tmp/other-archives\n        reason=""\n        verify_restored() {',
    "deps has one shell source of the archive directory",
  ],
  [
    "prune assigns its own archive directory",
    "deps",
    '        reason=""\n        prune_unneeded() {',
    '        archives=/tmp/other-archives\n        reason=""\n        prune_unneeded() {',
    "deps has one shell source of the archive directory",
  ],
  [
    "verify stops sourcing the library",
    "deps",
    '        source "$RUNNER_TEMP/linux-desktop-deps-lib.sh" || exit 1\n        reason=""\n        verify_restored() {',
    '        reason=""\n        verify_restored() {',
    "deps verify sources the library",
  ],
  [
    "prune stops sourcing the library",
    "deps",
    '        source "$RUNNER_TEMP/linux-desktop-deps-lib.sh" || exit 1\n        reason=""\n        prune_unneeded() {',
    '        reason=""\n        prune_unneeded() {',
    "deps prune sources the library",
  ],
  [
    "verify moved after download",
    "deps",
    /(    # apt 3\.2 checks only[\s\S]*?)(    - name: Download the missing[\s\S]*?)(?=    # Bound the cache)/gu,
    "$2$1",
    "deps steps run in the documented order",
  ],
  [
    "download re-adds an inline timeout",
    "deps",
    'desktop_deps_apt download "${download_args[@]}" || exit $?',
    'sudo timeout --kill-after=10 600 apt-get "${download_args[@]}" || exit $?',
    "deps has a single sudo timeout --kill-after form",
  ],
  [
    "update bypasses the helper",
    "deps",
    "desktop_deps_apt update update || exit $?",
    "sudo apt-get update || exit $?",
    "deps update goes through desktop_deps_apt",
  ],
  [
    "download bypasses the helper",
    "deps",
    'desktop_deps_apt download "${download_args[@]}" || exit $?',
    'sudo apt-get "${download_args[@]}" || exit $?',
    "deps download goes through desktop_deps_apt",
  ],
  [
    "resolve timeout input unmapped",
    "deps",
    "        TIMEOUT_MINUTES: ${{ inputs.timeout-minutes }}\n",
    '        TIMEOUT_MINUTES: ""\n',
    "deps resolve maps timeout-minutes to TIMEOUT_MINUTES",
  ],
  [
    "verify step id lost",
    "deps",
    "      id: verify\n",
    "      id: checked\n",
    "deps has a verify step",
  ],
  [
    "check helper dispatch removed",
    "deps",
    'case "${checksum%%:*}" in',
    "case MD5Sum in",
    "deps check helper dispatches on the checksum type",
  ],
  [
    "check helper loses the MD5Sum arm",
    "deps",
    "            MD5Sum) tool=md5sum ;;\n",
    "",
    "deps check helper handles MD5Sum",
  ],
  [
    "check helper loses the SHA256 arm",
    "deps",
    "            SHA256) tool=sha256sum ;;\n",
    "",
    "deps check helper handles SHA256",
  ],
  [
    "check helper stops rejecting a size mismatch",
    "deps",
    'if [ "$actual_size" != "$size" ]; then',
    "if false; then",
    "deps check helper rejects a size mismatch",
  ],
  [
    "check helper stops rejecting a checksum mismatch",
    "deps",
    'if [ "$digest" != "${checksum#*:}" ]; then',
    "if false; then",
    "deps check helper rejects a checksum mismatch",
  ],
  [
    "verify error discard removed",
    "deps",
    "          find \"$archives\" -maxdepth 1 -name '*.deb' -delete || true\n",
    "          true\n",
    "deps verify discards every file on a verification error",
  ],
  [
    "verify body replaced by exit 0",
    "deps",
    /(      id: verify\n      shell: bash\n      run: \|\n)[\s\S]*?(?=\n    - name: Download)/gu,
    "$1        exit 0\n",
    "deps verify uses the file-check helper",
  ],
  [
    "prune step id lost",
    "deps",
    "      id: prune\n",
    "      id: pruned\n",
    "deps has a prune step",
  ],
  [
    "download loses the fetched producer",
    "deps",
    'echo "fetched=true" >> "$GITHUB_OUTPUT"',
    'echo "fetched=1" >> "$GITHUB_OUTPUT"',
    "deps download emits fetched=true",
  ],
  [
    "prune loses the ok producer",
    "deps",
    'echo "ok=true" >> "$GITHUB_OUTPUT"',
    'echo "ok=1" >> "$GITHUB_OUTPUT"',
    "deps prune emits ok=true",
  ],
  [
    "restore key uses the set prefix",
    "deps",
    depsRestoreStepFragment,
    depsRestoreStepFragment.replace("save-key", "set-prefix"),
    "deps restore key is the save key",
  ],
  [
    "restore-keys lose the set prefix",
    "deps",
    "          ${{ steps.resolve.outputs.set-prefix }}\n",
    "",
    "deps restore-keys are the set and bare prefixes",
  ],
  [
    "restore-keys lose the bare prefix",
    "deps",
    "          ${{ steps.resolve.outputs.bare-prefix }}\n",
    "",
    "deps restore-keys are the set and bare prefixes",
  ],
  [
    "save key uses the set prefix",
    "deps",
    depsSaveStepFragment,
    depsSaveStepFragment.replace("save-key", "set-prefix"),
    "deps save key is the save key",
  ],
  [
    "install loses --no-download",
    "deps",
    "install --no-download ",
    "install ",
    "deps install uses --no-download",
  ],
  [
    "download continue-on-error removed",
    "deps",
    "      id: download\n      continue-on-error: true\n",
    "      id: download\n",
    "deps download continues on error",
  ],
  [
    "prune if uses success()",
    "deps",
    "if: steps.download.outcome == 'success'",
    "if: success()",
    "deps prune runs only after a successful download",
  ],
  [
    "prune if uses conclusion",
    "deps",
    "if: steps.download.outcome == 'success'",
    "if: steps.download.conclusion == 'success'",
    "deps prune runs only after a successful download",
  ],
  [
    "prune if removed",
    "deps",
    "      id: prune\n      if: steps.download.outcome == 'success'\n",
    "      id: prune\n",
    "deps prune runs only after a successful download",
  ],
  [
    "install maps conclusion instead of outcome",
    "deps",
    "DOWNLOAD_OUTCOME: ${{ steps.download.outcome }}",
    "DOWNLOAD_OUTCOME: ${{ steps.download.conclusion }}",
    "deps install maps the download outcome",
  ],
  [
    "prune stops writing the manifest",
    "deps",
    'if prune_unneeded && cp -- "$set_file" "$manifest"; then',
    "if prune_unneeded; then",
    "deps prune writes the manifest",
  ],
  [
    "library stops carrying the manifest",
    "deps",
    "declare -p packages archives manifest;",
    "declare -p packages archives;",
    "deps library carries the manifest path",
  ],
  [
    "restore path loses the manifest",
    "deps",
    depsRestoreStepFragment,
    depsRestoreStepFragment.replace(`\n          ${depsArchives}/${depsManifestName}`, ""),
    "deps restore and save share one cache path",
  ],
];

test("CI workflow wiring rejects removed selectors, checkout, freshness, publication and dist prerequisites", async (t) => {
  const texts = await readCiWorkflowTexts();
  // A row with a fifth element must turn at least that labelled contract red (other contracts may
  // legitimately fail too); the older rows only need some contract to fail.
  for (const [label, file, before, afterText = "", contract] of [
    [
      "re-added per-push frontend-mutation job",
      "test",
      "  rust:\n",
      "  frontend-mutation:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm mutation:frontend\n\n  rust:\n",
      "test has no frontend-mutation job",
    ],
    [
      "forbid push save of any other path",
      "test",
      "path: ~/.github-actionlint/bin",
      "path: .frontend-mutation-incremental",
      "no push save or combined cache",
    ],
    [
      "forbid quoted push save",
      "test",
      "uses: actions/cache@v4\n        with:\n          path: ~/.github-actionlint/bin",
      'uses: "actions/cache@v4"\n        with:\n          path: .frontend-mutation-incremental',
      "no push save or combined cache",
    ],
    [
      "forbid third push save cache path",
      "test",
      "path: ~/.cargo/bin/cargo-nextest.exe",
      "path: ~/.cargo/bin/other-tool.exe",
      "no push save or combined cache",
    ],
    ["forced sweep", "sweep", '      FRONTEND_MUTATION_FORCE: "1"\n'],
    ["success-only publication", "sweep", "        if: success()\n"],
    [
      "re-added sweep cache save",
      "sweep",
      "      - name: Run full frontend mutation sweep\n        run: pnpm mutation:frontend\n",
      "      - name: Run full frontend mutation sweep\n        run: pnpm mutation:frontend\n      - name: Save\n        uses: actions/cache/save@v4\n",
      "no sweep cache step",
    ],
    ["dist missing", "test", "        run: mkdir -p dist\n"],
    [
      "dist too late",
      "test",
      "        run: mkdir -p dist",
      "        run: cargo fmt --manifest-path src-tauri/Cargo.toml -- --check\n      - name: Late distribution directory\n        run: mkdir -p dist",
    ],
    ...linuxDesktopDepsRows,
  ]) {
    await t.test(label, () => {
      // Disposable strings exercise the same assertions used above, without touching the checkout.
      assertMutationRed({
        original: texts,
        mutate: (original) => ({
          ...original,
          [file]: original[file].replaceAll(before, afterText),
        }),
        failedFor: failedContracts,
        expected: contract,
      });
    });
  }
  await t.test("save moved after install", () => {
    const start = texts.deps.indexOf("    # Save only a set");
    const end = texts.deps.indexOf("    # `--no-download`");
    assert.ok(start > 0 && end > start);
    const moved = texts.deps.slice(0, start) + texts.deps.slice(end) + texts.deps.slice(start, end);
    assert.deepEqual(failedContracts({ ...texts, deps: moved }), [
      "deps steps run in the documented order",
    ]);
  });
});

// Executed helper test: the resolve step's shell helpers run in bash with `sudo` and `date`
// stubbed, so the deadline, stall-label and validation logic is run instead of text-matched. The
// clock is a variable the stubbed `sudo` advances, so no case sleeps.
const depsHelperNames = [
  "desktop_deps_label_stall",
  "desktop_deps_apt",
  "desktop_deps_bound_seconds",
];
const fakeNow = 1_800_000_000;

function depsHelperSource(depsText, names = depsHelperNames) {
  const resolve = workflowStepBlocks(depsText).find((step) => step.id === "resolve");
  assert.ok(resolve, "linux-desktop-deps has a resolve step");
  return names
    .map((name) => {
      const definition = new RegExp(`^ {8}${name}\\(\\) \\{\\n[\\s\\S]*?\\n {8}\\}$`, "mu").exec(
        resolve.text,
      );
      assert.ok(definition, `the resolve step defines ${name}`);
      return definition[0];
    })
    .join("\n");
}

// Runs `body` after the helper definitions. `sudo` prints its argv as `sudo-argv:<a><b>…`, advances
// the clock by SUDO_ELAPSE seconds and returns SUDO_STATUS.
function runDepsHelper(source, { env = {}, args = [], body }) {
  const script = [
    "set -uo pipefail",
    source,
    // Strict: only the exact `date +%s` call yields the fake epoch, any other form fails.
    'date() { if [ "$#" -eq 1 ] && [ "$1" = "+%s" ]; then printf "%s\\n" "$FAKE_NOW"; else echo "date: unexpected arguments: $*" >&2; return 2; fi; }',
    `sudo() { printf 'sudo-argv:'; printf '<%s>' "$@"; printf '\\n'; FAKE_NOW=$((FAKE_NOW + SUDO_ELAPSE)); return "$SUDO_STATUS"; }`,
    body,
  ].join("\n");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script, "bash", ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      FAKE_NOW: String(fakeNow),
      SUDO_STATUS: "0",
      SUDO_ELAPSE: "0",
      LINUX_DESKTOP_DEPS_START: String(fakeNow),
      LINUX_DESKTOP_DEPS_BOUND: "0",
      LINUX_DESKTOP_DEPS_DEADLINE: "",
      ...env,
    },
  });
  assert.equal(result.error, undefined, "bash ran");
  const lines = result.stdout.split("\n");
  return {
    status: result.status,
    calls: lines.filter((line) => line.startsWith("sudo-argv:")).map((line) => line.slice(10)),
    output: lines.filter((line) => !line.startsWith("sudo-argv:")).join("\n"),
  };
}

// A bound of 60 s that started 30 s ago, so 30 s remain.
const boundedEnv = (status, elapse) => ({
  LINUX_DESKTOP_DEPS_START: String(fakeNow - 30),
  LINUX_DESKTOP_DEPS_BOUND: "60",
  LINUX_DESKTOP_DEPS_DEADLINE: String(fakeNow + 30),
  SUDO_STATUS: String(status),
  SUDO_ELAPSE: String(elapse),
});
const unboundedEnv = (status) => ({
  LINUX_DESKTOP_DEPS_START: String(fakeNow - 30),
  LINUX_DESKTOP_DEPS_BOUND: "0",
  LINUX_DESKTOP_DEPS_DEADLINE: "",
  SUDO_STATUS: String(status),
  SUDO_ELAPSE: "30",
});
const aptArgs = ["download", "install", "--download-only"];
const runApt = (source, env) =>
  runDepsHelper(source, { env, args: aptArgs, body: 'desktop_deps_apt "$@"; exit $?' });
const runBound = (source, minutes) =>
  runDepsHelper(source, { args: [minutes], body: 'desktop_deps_bound_seconds "$1"; exit $?' });
const stallLabel = "mirror stall: apt-get download was stopped after";

const depsHelperCases = [
  [
    "a used-up deadline returns 1 with the used-up label and no sudo call",
    (source) => {
      // remaining is exactly 0 here, so `-le 0` and `-lt 0` differ.
      const result = runApt(source, {
        ...boundedEnv(0, 0),
        LINUX_DESKTOP_DEPS_START: String(fakeNow - 60),
        LINUX_DESKTOP_DEPS_DEADLINE: String(fakeNow),
      });
      assert.equal(result.status, 1);
      assert.match(
        result.output,
        /bound is used up \(60s elapsed\) before apt-get download started/u,
      );
      assert.deepEqual(result.calls, []);
    },
  ],
  [
    "bounded: 124 at the bound is labelled and returned",
    (source) => {
      // The clock reaches START + 60 exactly, so `-ge` and `-gt` differ.
      const result = runApt(source, boundedEnv(124, 30));
      assert.equal(result.status, 124);
      assert.ok(
        result.output.includes(`${stallLabel} 60s, past the 60s bound`),
        `no expiry label in: ${result.output}`,
      );
    },
  ],
  [
    "bounded: 137 at the bound is labelled and returned",
    (source) => {
      const result = runApt(source, boundedEnv(137, 40));
      assert.equal(result.status, 137);
      assert.ok(result.output.includes(`${stallLabel} 70s, past the 60s bound`));
    },
  ],
  [
    "bounded: 137 before the bound is not labelled",
    (source) => {
      const result = runApt(source, boundedEnv(137, 10));
      assert.equal(result.status, 137);
      assert.ok(!result.output.includes("mirror stall"), result.output);
    },
  ],
  [
    "bounded: a non-timeout status is returned without a label",
    (source) => {
      const result = runApt(source, boundedEnv(100, 40));
      assert.equal(result.status, 100);
      assert.ok(!result.output.includes("mirror stall"), result.output);
    },
  ],
  [
    "bounded: sudo runs timeout --kill-after=10 with the remaining seconds",
    (source) => {
      const result = runApt(source, boundedEnv(0, 0));
      assert.equal(result.status, 0);
      assert.deepEqual(result.calls, [
        "<timeout><--kill-after=10><30><apt-get><install><--download-only>",
      ]);
    },
  ],
  ...[124, 137].map((status) => [
    `unbounded: ${status} is not labelled and sudo runs without timeout`,
    (source) => {
      const result = runApt(source, unboundedEnv(status));
      assert.equal(result.status, status);
      assert.ok(!result.output.includes("mirror stall"), result.output);
      assert.deepEqual(result.calls, ["<apt-get><install><--download-only>"]);
    },
  ]),
  [
    "validation rejects 0, -1, abc and 0.0 naming the value",
    (source) => {
      for (const value of ["0", "-1", "abc", "0.0"]) {
        const result = runBound(source, value);
        assert.equal(result.status, 1, `${value} was accepted`);
        assert.ok(
          result.output.includes(
            `::error::linux-desktop-deps: timeout-minutes must be a positive number of minutes or empty, got '${value}'`,
          ),
          `${value}: ${result.output}`,
        );
      }
    },
  ],
  [
    "validation turns 1.5 minutes into 90 seconds",
    (source) => {
      const result = runBound(source, "1.5");
      assert.equal(result.status, 0);
      assert.equal(result.output.trim(), "90");
    },
  ],
  [
    "validation rounds 0.01 minutes up to 1 second",
    (source) => {
      const result = runBound(source, "0.01");
      assert.equal(result.status, 0);
      assert.equal(result.output.trim(), "1");
    },
  ],
  [
    "an empty value means unbounded",
    (source) => {
      const result = runBound(source, "");
      assert.equal(result.status, 0);
      assert.equal(result.output.trim(), "0");
    },
  ],
];

// The bash cases are not ciWorkflowContracts entries, so they run once per mutation, not once per
// table row.
function failedDepsHelperCases(source) {
  return failingNames(depsHelperCases.map(([name, run]) => [name, () => run(source)]));
}

// [label, before, after, the case that must turn red]
const depsHelperMutations = [
  [
    "used-up guard accepts a remaining of 0",
    '[ "$remaining" -le 0 ]',
    '[ "$remaining" -lt 0 ]',
    "a used-up deadline returns 1 with the used-up label and no sudo call",
  ],
  [
    "stall filter drops 137",
    ' && [ "$2" -ne 137 ]',
    "",
    "bounded: 137 at the bound is labelled and returned",
  ],
  [
    "expiry needs elapsed past the bound",
    '[ "$elapsed" -ge "$LINUX_DESKTOP_DEPS_BOUND" ]',
    '[ "$elapsed" -gt "$LINUX_DESKTOP_DEPS_BOUND" ]',
    "bounded: 124 at the bound is labelled and returned",
  ],
  [
    "unbounded guard removed",
    '          if [ -z "$LINUX_DESKTOP_DEPS_DEADLINE" ]; then return 0; fi\n',
    "",
    "unbounded: 124 is not labelled and sudo runs without timeout",
  ],
  [
    "validation accepts 0",
    '[ "$seconds" -le 0 ]',
    '[ "$seconds" -lt 0 ]',
    "validation rejects 0, -1, abc and 0.0 naming the value",
  ],
  [
    "validation rounds down",
    "(whole < seconds ? whole + 1 : whole)",
    "whole",
    "validation rounds 0.01 minutes up to 1 second",
  ],
  [
    "remaining read in another date format",
    "now=$(date +%s)",
    "now=$(date +%S)",
    "bounded: sudo runs timeout --kill-after=10 with the remaining seconds",
  ],
  [
    "elapsed read in another date format",
    "$(date +%s) - LINUX_DESKTOP_DEPS_START",
    "$(date +%S) - LINUX_DESKTOP_DEPS_START",
    "bounded: 124 at the bound is labelled and returned",
  ],
  [
    "bounded run loses sudo timeout",
    'sudo timeout --kill-after="$kill_grace" "$remaining" apt-get "$@"',
    'sudo apt-get "$@"',
    "bounded: sudo runs timeout --kill-after=10 with the remaining seconds",
  ],
];

test("linux-desktop-deps helpers behave when executed", async (t) => {
  const { deps } = await readCiWorkflowTexts();
  const source = depsHelperSource(deps);
  assert.deepEqual(failedDepsHelperCases(source), []);
  for (const [label, before, after, expected] of depsHelperMutations) {
    await t.test(label, (subtest) =>
      assertMutationRed({
        original: source,
        mutate: (original) => original.replaceAll(before, after),
        failedFor: failedDepsHelperCases,
        expected,
        report: (failed) => subtest.diagnostic(`red: ${failed.join(" | ")}`),
      }),
    );
  }
});

// Executed resolve-prologue test: the resolve step's real run body runs in bash (`-eo pipefail`, as
// GitHub runs `shell: bash`) with `date`, `sudo`, `mkdir` and `rm` replaced by PATH shims inside a
// per-test temporary directory. `sudo` records its argv and a snapshot of GITHUB_ENV at call time,
// then fails, so the step ends right after `apt-get update` and never reaches the archive
// directory. The `mkdir` and `rm` shims fail loudly if that ever stops being true.
const resolveEpoch = 1_800_000_000;

function depsStepRunBody(depsText, id) {
  const step = workflowStepBlocks(depsText).find((candidate) => candidate.id === id);
  assert.ok(step, `linux-desktop-deps has a ${id} step`);
  const lines = step.text.split("\n");
  const runIndex = lines.indexOf("      run: |");
  assert.ok(runIndex >= 0, `the ${id} step has a run body`);
  return lines
    .slice(runIndex + 1)
    .map((line) => line.slice(8))
    .join("\n");
}

function depsResolveBody(depsText) {
  return depsStepRunBody(depsText, "resolve");
}

function runResolveBody(body, timeoutMinutes) {
  const dir = mkdtempSync(join(tmpdir(), "linux-desktop-deps-resolve-"));
  try {
    const bin = join(dir, "bin");
    const runnerTemp = join(dir, "runner-temp");
    mkdirSync(bin);
    mkdirSync(runnerTemp);
    const shim = (name, text) =>
      writeFileSync(join(bin, name), `#!/bin/bash\n${text}\n`, { mode: 0o755 });
    // Strict: only the exact `date +%s` call yields the fake epoch, any other form fails.
    shim(
      "date",
      'if [ "$#" -eq 1 ] && [ "$1" = "+%s" ]; then echo "$FAKE_EPOCH"; else echo "date: unexpected arguments: $*" >&2; exit 2; fi',
    );
    shim(
      "sudo",
      `{ printf 'argv:'; printf '<%s>' "$@"; printf '\\n'; } >> "$SHIM_DIR/sudo-calls"\ncp "$GITHUB_ENV" "$SHIM_DIR/env-at-sudo"\nexit 1`,
    );
    for (const name of ["mkdir", "rm"])
      shim(name, `echo "${name} $*" >> "$SHIM_DIR/forbidden"\nexit 99`);
    const githubEnv = join(runnerTemp, "github_env");
    writeFileSync(githubEnv, "");
    const script = join(dir, "resolve.sh");
    writeFileSync(script, body);
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
      encoding: "utf8",
      cwd: dir,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: runnerTemp,
        GITHUB_ENV: githubEnv,
        GITHUB_OUTPUT: join(runnerTemp, "github_output"),
        TIMEOUT_MINUTES: timeoutMinutes,
        FAKE_EPOCH: String(resolveEpoch),
        SHIM_DIR: dir,
      },
    });
    assert.equal(result.error, undefined, "bash ran");
    const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);
    assert.equal(read(join(dir, "forbidden")), undefined, "the step reached mkdir or rm");
    return {
      status: result.status,
      output: result.stdout,
      calls: (read(join(dir, "sudo-calls")) ?? "").split("\n").filter(Boolean),
      envAtSudo: read(join(dir, "env-at-sudo")),
      env: read(githubEnv),
      library: read(join(runnerTemp, "linux-desktop-deps-lib.sh")),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const exportedEnv = (bound, deadline) =>
  `LINUX_DESKTOP_DEPS_START=${resolveEpoch}\nLINUX_DESKTOP_DEPS_BOUND=${bound}\nLINUX_DESKTOP_DEPS_DEADLINE=${deadline}\n`;

const resolveCases = [
  [
    "TIMEOUT_MINUTES=18 exports the deadline, then runs update under timeout",
    (body) => {
      const result = runResolveBody(body, "18");
      assert.equal(result.status, 1);
      assert.ok(!result.output.includes("mirror stall"), result.output);
      assert.deepEqual(result.calls, ["argv:<timeout><--kill-after=10><1080><apt-get><update>"]);
      // The snapshot was taken inside the update call, so the export came first.
      assert.equal(result.envAtSudo, exportedEnv(1080, resolveEpoch + 1080));
      assert.equal(result.env, exportedEnv(1080, resolveEpoch + 1080));
      assert.match(result.library, /^declare -a packages=/mu);
      assert.match(result.library, /^declare -- archives="\/tmp\/[^"]+"$/mu);
      assert.match(result.library, /^declare -- manifest="\/tmp\/[^"]+"$/mu);
      assert.match(result.library, /^desktop_deps_label_stall \(\) *$/mu);
      assert.match(result.library, /^desktop_deps_apt \(\) *$/mu);
      assert.match(result.library, /^desktop_deps_check_file \(\) *$/mu);
    },
  ],
  [
    "an empty TIMEOUT_MINUTES runs update unbounded",
    (body) => {
      const result = runResolveBody(body, "");
      assert.equal(result.status, 1);
      assert.ok(!result.output.includes("mirror stall"), result.output);
      assert.deepEqual(result.calls, ["argv:<apt-get><update>"]);
      assert.equal(result.envAtSudo, exportedEnv(0, ""));
      assert.equal(result.env, exportedEnv(0, ""));
    },
  ],
  [
    "TIMEOUT_MINUTES=0 fails before any sudo call and exports nothing",
    (body) => {
      const result = runResolveBody(body, "0");
      assert.equal(result.status, 1);
      assert.ok(result.output.includes("::error::linux-desktop-deps: timeout-minutes must be"));
      assert.ok(result.output.includes("got '0'"), result.output);
      assert.deepEqual(result.calls, []);
      assert.equal(result.envAtSudo, undefined);
      assert.equal(result.env, "");
    },
  ],
];

function failedResolveCases(body) {
  return failingNames(resolveCases.map(([name, run]) => [name, () => run(body)]));
}

const replaceText = (before, after) => (body) => {
  assert.ok(body.includes(before), `the resolve body lacks: ${before}`);
  return body.replaceAll(before, after);
};
// Moves the block matched by `block` in front of the line `anchor`.
const moveBefore = (block, anchor) => (body) => {
  const found = block.exec(body);
  assert.ok(found && body.includes(anchor), "the resolve body lacks the block or its anchor");
  return body.replace(found[0], "").replace(anchor, found[0] + anchor);
};
const startLine = "LINUX_DESKTOP_DEPS_START=$(date +%s)\n";
const exportBlock = /^\{\n {2}echo "LINUX_DESKTOP_DEPS_START=[\s\S]*?\} >> "\$GITHUB_ENV"\n/mu;
const boundCall =
  'bound=$(desktop_deps_bound_seconds "$TIMEOUT_MINUTES") || { printf \'%s\\n\' "$bound"; exit 1; }';
const [cases18, casesEmpty, cases0] = resolveCases.map(([name]) => name);

// [label, mutation of the resolve body, the case that must turn red]
const resolveMutations = [
  [
    "update call moved above the deadline derivation",
    moveBefore(/^desktop_deps_apt update update \|\| exit \$\?\n/mu, startLine),
    cases18,
  ],
  [
    "GITHUB_ENV export moved above the derivation lines",
    moveBefore(exportBlock, startLine),
    cases18,
  ],
  ["bound call replaced by bound=0", replaceText(boundCall, "bound=0"), cases18],
  [
    "bound call loses the abort",
    replaceText(` || { printf '%s\\n' "$bound"; exit 1; }`, ""),
    cases0,
  ],
  [
    "bound call is not given TIMEOUT_MINUTES",
    replaceText('desktop_deps_bound_seconds "$TIMEOUT_MINUTES")', 'desktop_deps_bound_seconds "")'),
    cases18,
  ],
  [
    "deadline guard dropped",
    replaceText(
      'if [ "$bound" -gt 0 ]; then LINUX_DESKTOP_DEPS_DEADLINE=$((LINUX_DESKTOP_DEPS_START + bound)); fi',
      "LINUX_DESKTOP_DEPS_DEADLINE=$((LINUX_DESKTOP_DEPS_START + bound))",
    ),
    casesEmpty,
  ],
  ["deadline default dropped", replaceText('LINUX_DESKTOP_DEPS_DEADLINE=""\n', ""), casesEmpty],
  ["START set to 0", replaceText(startLine, "LINUX_DESKTOP_DEPS_START=0\n"), cases18],
  [
    "START read with a bare date",
    replaceText(startLine, "LINUX_DESKTOP_DEPS_START=$(date)\n"),
    cases18,
  ],
  ...["START", "BOUND", "DEADLINE"].map((name) => [
    `${name} not exported`,
    replaceText(`  echo "LINUX_DESKTOP_DEPS_${name}=$LINUX_DESKTOP_DEPS_${name}"\n`, ""),
    cases18,
  ]),
  [
    "export goes to GITHUB_OUTPUT",
    replaceText('} >> "$GITHUB_ENV"', '} >> "$GITHUB_OUTPUT"'),
    cases18,
  ],
  [
    "library stops carrying archives",
    replaceText("declare -p packages archives manifest;", "declare -p packages manifest;"),
    cases18,
  ],
  [
    "library stops carrying the manifest",
    replaceText("declare -p packages archives manifest;", "declare -p packages archives;"),
    cases18,
  ],
  [
    "library drops the label function",
    replaceText(
      "declare -f desktop_deps_label_stall desktop_deps_apt desktop_deps_check_file;",
      "declare -f desktop_deps_apt desktop_deps_check_file;",
    ),
    cases18,
  ],
  [
    "library drops the apt function",
    replaceText(
      "declare -f desktop_deps_label_stall desktop_deps_apt desktop_deps_check_file;",
      "declare -f desktop_deps_label_stall desktop_deps_check_file;",
    ),
    cases18,
  ],
  [
    "library drops the file-check helper",
    replaceText(
      "declare -f desktop_deps_label_stall desktop_deps_apt desktop_deps_check_file;",
      "declare -f desktop_deps_label_stall desktop_deps_apt;",
    ),
    cases18,
  ],
];

test("linux-desktop-deps resolve prologue behaves when executed", async (t) => {
  const { deps } = await readCiWorkflowTexts();
  const body = depsResolveBody(deps);
  assert.deepEqual(failedResolveCases(body), []);
  for (const [label, mutate, expected] of resolveMutations)
    await t.test(label, (subtest) =>
      assertMutationRed({
        original: body,
        mutate,
        failedFor: failedResolveCases,
        expected,
        report: (failed) => subtest.diagnostic(`red: ${failed.join(" | ")}`),
      }),
    );
});

// Executed pipeline test: the real verify body, then the real install body, with the real
// file-check helper extracted from action.yml. Only archives, packages and the manifest path are
// test-written. sudo records argv; dpkg-deb -f is shimmed.
const pipelinePackages = ["alpha", "alpha-common", "beta"];
const noUsableSetError =
  "::error::linux-desktop-deps: the package download failed and no usable cached package set is available";
const cachedInstallFailedError =
  "::error::linux-desktop-deps: installing the cached package set failed";
const fallbackWarning =
  "::warning::linux-desktop-deps: the job tests against cached versions because the mirror download failed";

function sha256Hex(content) {
  return createHash("sha256").update(content).digest("hex");
}

function debRecord(name, content) {
  return `${name} ${Buffer.byteLength(content)} SHA256:${sha256Hex(content)}`;
}

function pipelineParts(depsText) {
  return {
    helper: depsHelperSource(depsText, ["desktop_deps_check_file"]),
    verify: depsStepRunBody(depsText, "verify"),
    install: depsStepRunBody(depsText, "install"),
  };
}

function argvTokens(call) {
  return [...call.matchAll(/<([^>]*)>/gu)].map((match) => match[1]);
}

function assertFallbackArgv(call, archives, pins) {
  const tokens = argvTokens(call);
  const optionAt = tokens.indexOf("-o");
  assert.ok(optionAt >= 0, `no -o in ${call}`);
  assert.equal(tokens[optionAt + 1], `Dir::Cache::Archives=${archives}`);
  const installAt = tokens.indexOf("install");
  assert.deepEqual(tokens.slice(installAt, installAt + 4), [
    "install",
    "--no-download",
    "--no-install-recommends",
    "-y",
  ]);
  const rest = tokens.slice(installAt + 4);
  for (const pkg of pipelinePackages)
    assert.ok(rest.includes(pkg), `missing package ${pkg} in ${rest}`);
  for (const pin of pins) assert.ok(rest.includes(pin), `missing pin ${pin} in ${rest}`);
  assert.deepEqual(
    rest.filter((token) => !pipelinePackages.includes(token) && !pins.includes(token)),
    [],
    `unexpected apt arguments in ${rest}`,
  );
  assert.equal(rest.length, pipelinePackages.length + pins.length);
}

const pipelineDebs = {
  alphaOld: "alpha_1.0_amd64.deb",
  alphaNew: "alpha_2.0_amd64.deb",
  commonOld: "alpha-common_1.0_amd64.deb",
  commonNew: "alpha-common_2.0_amd64.deb",
  betaOld: "beta_1.0_amd64.deb",
  betaNew: "beta_2.0_amd64.deb",
  gamma: "gamma_9.0_amd64.deb",
  delta: "delta_3.0_amd64.deb",
};
const pipelineContents = {
  alphaOld: "alpha-old\n",
  alphaNew: "alpha-new\n",
  commonOld: "common-old\n",
  commonNew: "common-new\n",
  beta: "beta-same\n",
  gamma: "gamma-extra\n",
  delta: "delta-only\n",
};

function incidentFiles() {
  return {
    [pipelineDebs.alphaOld]: pipelineContents.alphaOld,
    [pipelineDebs.commonOld]: pipelineContents.commonOld,
    [pipelineDebs.betaOld]: pipelineContents.beta,
    [pipelineDebs.gamma]: pipelineContents.gamma,
  };
}

function incidentCurrentSet() {
  return [
    debRecord(pipelineDebs.alphaNew, pipelineContents.alphaNew),
    debRecord(pipelineDebs.commonNew, pipelineContents.commonNew),
    debRecord(pipelineDebs.betaNew, pipelineContents.beta),
  ];
}

function incidentManifest() {
  return [
    debRecord(pipelineDebs.alphaOld, pipelineContents.alphaOld),
    debRecord(pipelineDebs.commonOld, pipelineContents.commonOld),
    debRecord(pipelineDebs.betaOld, pipelineContents.beta),
    debRecord(pipelineDebs.gamma, pipelineContents.gamma),
  ];
}

function incidentPins() {
  return ["alpha=1.0", "alpha-common=1.0", "beta=1.0"];
}

function runDepsPipeline(parts, fixture) {
  const dir = mkdtempSync(join(tmpdir(), "linux-desktop-deps-pipeline-"));
  try {
    const bin = join(dir, "bin");
    const archives = join(dir, "archives");
    const runnerTemp = join(dir, "runner-temp");
    mkdirSync(bin);
    mkdirSync(archives);
    mkdirSync(runnerTemp);
    const manifestPath = join(archives, depsManifestName);
    const shim = (name, text) =>
      writeFileSync(join(bin, name), `#!/bin/bash\n${text}\n`, { mode: 0o755 });
    shim(
      "sudo",
      `printf 'sudo-argv:'; printf '<%s>' "$@"; printf '\\n'; exit "\${SUDO_STATUS:-0}"`,
    );
    shim(
      "dpkg-deb",
      `if [ "$1" != "-f" ] || [ "$#" -ne 3 ]; then echo "dpkg-deb: unexpected arguments: $*" >&2; exit 2; fi
if [ -f "$SHIM_DIR/dpkg-fail" ]; then echo "dpkg-deb failed" >&2; exit 1; fi
base=\${2##*/}
rest=\${base%.deb}
pkg=\${rest%%_*}
rest=\${rest#*_}
ver=\${rest%_*}
ver=\${ver//%3a/:} # apt percent-encodes the epoch colon in archive filenames (\`1%3a2.0-1\` for \`1:2.0-1\`).
case "$3" in
  Package) printf '%s\\n' "$pkg" ;;
  Version) printf '%s\\n' "$ver" ;;
  *) echo "dpkg-deb: unexpected field $3" >&2; exit 2 ;;
esac`,
    );
    for (const [name, content] of Object.entries(fixture.files ?? {}))
      writeFileSync(join(archives, name), content);
    writeFileSync(
      join(runnerTemp, "linux-desktop-deps-set.txt"),
      fixture.currentSet?.length ? `${fixture.currentSet.join("\n")}\n` : "",
    );
    if (fixture.manifest) writeFileSync(manifestPath, `${fixture.manifest.join("\n")}\n`);
    if (fixture.dpkgFail) writeFileSync(join(dir, "dpkg-fail"), "");
    writeFileSync(
      join(runnerTemp, "linux-desktop-deps-lib.sh"),
      [
        `packages=(${pipelinePackages.join(" ")})`,
        `archives=${JSON.stringify(archives)}`,
        `manifest=${JSON.stringify(manifestPath)}`,
        parts.helper,
        "",
      ].join("\n"),
    );
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: runnerTemp,
      DOWNLOAD_OUTCOME: fixture.downloadOutcome,
      SUDO_STATUS: String(fixture.sudoStatus ?? 0),
      SHIM_DIR: dir,
    };
    const run = (name, body) => {
      const script = join(dir, `${name}.sh`);
      writeFileSync(script, body);
      const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
        encoding: "utf8",
        env,
      });
      assert.equal(result.error, undefined, "bash ran");
      const combined = `${result.stdout}${result.stderr}`;
      return {
        status: result.status,
        output: combined,
        calls: combined
          .split("\n")
          .filter((line) => line.startsWith("sudo-argv:"))
          .map((line) => line.slice(10)),
      };
    };
    const verify = run("verify", parts.verify);
    const debsAfterVerify = readdirSync(archives)
      .filter((name) => name.endsWith(".deb"))
      .sort();
    const install = run("install", parts.install);
    return { archives, verify, install, debsAfterVerify };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertNoUsableSet(install, reason) {
  assert.equal(install.status, 1, install.output);
  assert.deepEqual(install.calls, []);
  assert.ok(install.output.includes(`${noUsableSetError} (${reason})`), install.output);
}

const pipelineCases = [
  [
    "success outcome: one apt call without pins",
    (parts) => {
      const result = runDepsPipeline(parts, {
        downloadOutcome: "success",
        files: {
          [pipelineDebs.alphaNew]: pipelineContents.alphaNew,
          [pipelineDebs.commonNew]: pipelineContents.commonNew,
          [pipelineDebs.betaNew]: pipelineContents.beta,
        },
        currentSet: incidentCurrentSet(),
      });
      assert.equal(result.verify.status, 0, result.verify.output);
      assert.equal(result.install.status, 0, result.install.output);
      assert.equal(result.install.calls.length, 1);
      assert.deepEqual(argvTokens(result.install.calls[0]), [
        "apt-get",
        "-o",
        `Dir::Cache::Archives=${result.archives}`,
        "install",
        "--no-download",
        "--no-install-recommends",
        "-y",
        ...pipelinePackages,
      ]);
      assert.ok(!result.install.output.includes(fallbackWarning), result.install.output);
    },
  ],
  [
    "failed download installs the verified previous set",
    (parts) => {
      const result = runDepsPipeline(parts, {
        downloadOutcome: "failure",
        files: incidentFiles(),
        currentSet: incidentCurrentSet(),
        manifest: incidentManifest(),
      });
      assert.equal(result.verify.status, 0, result.verify.output);
      assert.deepEqual(result.debsAfterVerify, Object.keys(incidentFiles()).sort());
      assert.equal(result.install.status, 0, result.install.output);
      assert.equal(result.install.calls.length, 1);
      assertFallbackArgv(result.install.calls[0], result.archives, incidentPins());
      assert.ok(result.install.output.includes(fallbackWarning), result.install.output);
      for (const named of [
        "alpha 1.0 (candidate 2.0)",
        "alpha-common 1.0 (candidate 2.0)",
        "beta 1.0 (candidate 2.0)",
      ])
        assert.ok(result.install.output.includes(named), result.install.output);
      assert.ok(!result.install.calls[0].includes("gamma="), result.install.calls[0]);
    },
  ],
  [
    "failed download pins a current-set file and a newer sibling to the manifest versions",
    (parts) => {
      const result = runDepsPipeline(parts, {
        downloadOutcome: "failure",
        files: {
          [pipelineDebs.alphaOld]: pipelineContents.alphaOld,
          [pipelineDebs.commonOld]: pipelineContents.commonOld,
          [pipelineDebs.commonNew]: pipelineContents.commonNew,
          [pipelineDebs.betaOld]: pipelineContents.beta,
        },
        currentSet: [
          debRecord(pipelineDebs.alphaNew, pipelineContents.alphaNew),
          debRecord(pipelineDebs.commonNew, pipelineContents.commonNew),
          debRecord(pipelineDebs.betaOld, pipelineContents.beta),
        ],
        manifest: [
          debRecord(pipelineDebs.alphaOld, pipelineContents.alphaOld),
          debRecord(pipelineDebs.commonOld, pipelineContents.commonOld),
          debRecord(pipelineDebs.betaOld, pipelineContents.beta),
        ],
      });
      assert.equal(result.verify.status, 0, result.verify.output);
      assert.ok(result.debsAfterVerify.includes(pipelineDebs.commonNew));
      assert.ok(result.debsAfterVerify.includes(pipelineDebs.betaOld));
      assert.equal(result.install.status, 0, result.install.output);
      assert.equal(result.install.calls.length, 1);
      assertFallbackArgv(result.install.calls[0], result.archives, incidentPins());
      assert.ok(result.install.output.includes(fallbackWarning), result.install.output);
      assert.ok(result.install.output.includes("alpha 1.0 (candidate 2.0)"), result.install.output);
      assert.ok(
        result.install.output.includes("alpha-common 1.0 (candidate 2.0)"),
        result.install.output,
      );
      assert.ok(!result.install.output.includes("beta 1.0 (candidate"), result.install.output);
    },
  ],
  [
    "failed download with matching versions warns without candidate text",
    (parts) => {
      const result = runDepsPipeline(parts, {
        downloadOutcome: "failure",
        files: {
          [pipelineDebs.alphaOld]: pipelineContents.alphaOld,
          [pipelineDebs.commonOld]: pipelineContents.commonOld,
          [pipelineDebs.betaOld]: pipelineContents.beta,
          [pipelineDebs.gamma]: pipelineContents.gamma,
        },
        currentSet: [
          debRecord(pipelineDebs.alphaOld, pipelineContents.alphaOld),
          debRecord(pipelineDebs.commonOld, pipelineContents.commonOld),
          debRecord(pipelineDebs.betaOld, pipelineContents.beta),
        ],
        manifest: incidentManifest(),
      });
      assert.equal(result.verify.status, 0, result.verify.output);
      assert.equal(result.install.status, 0, result.install.output);
      assert.equal(result.install.calls.length, 1);
      assertFallbackArgv(result.install.calls[0], result.archives, incidentPins());
      const warnings = result.install.output
        .split("\n")
        .filter((line) => line.startsWith("::warning::"));
      assert.deepEqual(warnings, [fallbackWarning]);
      assert.ok(!result.install.output.includes("(candidate"), result.install.output);
    },
  ],
  [
    "verify discards every restored file on a check error",
    (parts) => {
      const result = runDepsPipeline(parts, {
        downloadOutcome: "success",
        files: {
          ...incidentFiles(),
          [pipelineDebs.alphaNew]: pipelineContents.alphaNew,
        },
        currentSet: [
          `${pipelineDebs.alphaNew} ${Buffer.byteLength(pipelineContents.alphaNew)} UNKNOWN:${sha256Hex(pipelineContents.alphaNew)}`,
        ],
      });
      assert.equal(result.verify.status, 0, result.verify.output);
      assert.deepEqual(result.debsAfterVerify, []);
      assert.ok(
        result.verify.output.includes(
          "::warning::linux-desktop-deps: verifying the restored apt archives failed (unsupported checksum type UNKNOWN); discarding them, every package comes from the mirror",
        ),
        result.verify.output,
      );
    },
  ],
  [
    "size mismatch prints the no-usable-set error and never calls apt",
    (parts) => {
      const result = runDepsPipeline(parts, {
        downloadOutcome: "failure",
        files: { ...incidentFiles(), [pipelineDebs.alphaOld]: `${pipelineContents.alphaOld}x` },
        currentSet: incidentCurrentSet(),
        manifest: incidentManifest(),
      });
      const actual = Buffer.byteLength(`${pipelineContents.alphaOld}x`);
      const expected = Buffer.byteLength(pipelineContents.alphaOld);
      assertNoUsableSet(
        result.install,
        `${pipelineDebs.alphaOld}: size ${actual}, expected ${expected}`,
      );
    },
  ],
  [
    "checksum mismatch prints the no-usable-set error and never calls apt",
    (parts) => {
      const size = Buffer.byteLength(pipelineContents.alphaOld);
      const actual = sha256Hex(pipelineContents.alphaOld);
      const expected = "0".repeat(64);
      const result = runDepsPipeline(parts, {
        downloadOutcome: "failure",
        files: incidentFiles(),
        currentSet: incidentCurrentSet(),
        manifest: [
          `${pipelineDebs.alphaOld} ${size} SHA256:${expected}`,
          ...incidentManifest().slice(1),
        ],
      });
      assertNoUsableSet(
        result.install,
        `${pipelineDebs.alphaOld}: SHA256 ${actual}, expected ${expected}`,
      );
    },
  ],
  [
    "missing cached file prints the no-usable-set error and never calls apt",
    (parts) => {
      const files = incidentFiles();
      delete files[pipelineDebs.gamma];
      const result = runDepsPipeline(parts, {
        downloadOutcome: "failure",
        files,
        currentSet: incidentCurrentSet(),
        manifest: incidentManifest(),
      });
      assertNoUsableSet(result.install, `cached file ${pipelineDebs.gamma} is missing`);
    },
  ],
  [
    "missing manifest prints the no-usable-set error and never calls apt",
    (parts) => {
      const result = runDepsPipeline(parts, {
        downloadOutcome: "failure",
        files: incidentFiles(),
        currentSet: incidentCurrentSet(),
      });
      assertNoUsableSet(result.install, "restored manifest is missing");
    },
  ],
  [
    "malformed manifest line prints the no-usable-set error and never calls apt",
    (parts) => {
      const result = runDepsPipeline(parts, {
        downloadOutcome: "failure",
        files: incidentFiles(),
        currentSet: incidentCurrentSet(),
        manifest: ["not a valid line", ...incidentManifest()],
      });
      assertNoUsableSet(result.install, "malformed manifest line");
    },
  ],
  [
    "current name without a manifest entry prints the no-usable-set error and never calls apt",
    (parts) => {
      const result = runDepsPipeline(parts, {
        downloadOutcome: "failure",
        files: incidentFiles(),
        currentSet: [
          ...incidentCurrentSet(),
          debRecord(pipelineDebs.delta, pipelineContents.delta),
        ],
        manifest: incidentManifest(),
      });
      assertNoUsableSet(result.install, "current-set package delta has no cached version");
    },
  ],
  [
    "dpkg-deb failure prints the no-usable-set error and never calls apt",
    (parts) => {
      const result = runDepsPipeline(parts, {
        downloadOutcome: "failure",
        files: incidentFiles(),
        currentSet: incidentCurrentSet(),
        manifest: incidentManifest(),
        dpkgFail: true,
      });
      assertNoUsableSet(result.install, `cannot read Package from ${pipelineDebs.alphaOld}`);
    },
  ],
  [
    "fallback apt failure prints the install-failed error with apt's status",
    (parts) => {
      const result = runDepsPipeline(parts, {
        downloadOutcome: "failure",
        files: incidentFiles(),
        currentSet: incidentCurrentSet(),
        manifest: incidentManifest(),
        sudoStatus: 100,
      });
      assert.equal(result.install.status, 100, result.install.output);
      assert.equal(result.install.calls.length, 1);
      assert.ok(result.install.output.includes(cachedInstallFailedError), result.install.output);
    },
  ],
];

function failedPipelineCases(parts) {
  return failingNames(pipelineCases.map(([name, run]) => [name, () => run(parts)]));
}

const replacePipeline = (field, before, after) => (parts) => {
  assert.ok(parts[field].includes(before), `the ${field} body lacks: ${before}`);
  return { ...parts, [field]: parts[field].replaceAll(before, after) };
};

const pipelineMutations = [
  [
    "success branch never matches",
    replacePipeline(
      "install",
      '"${DOWNLOAD_OUTCOME:-}" = "success"',
      '"${DOWNLOAD_OUTCOME:-}" = "never"',
    ),
    "success outcome: one apt call without pins",
  ],
  [
    "success install loses the archive directory",
    replacePipeline(
      "install",
      'sudo apt-get -o "Dir::Cache::Archives=$archives" install --no-download --no-install-recommends -y "${packages[@]}"\n  exit $?',
      'sudo apt-get install --no-download --no-install-recommends -y "${packages[@]}"\n  exit $?',
    ),
    "success outcome: one apt call without pins",
  ],
  [
    "fallback loses the version pins",
    replacePipeline("install", ' "${packages[@]}" "${pins[@]}"', ' "${packages[@]}"'),
    "failed download installs the verified previous set",
  ],
  [
    "fallback pins only when the version differs",
    replacePipeline(
      "install",
      'pins+=("${pkg}=${cached[$pkg]}")\n    candidate=${candidates[$pkg]}',
      'candidate=${candidates[$pkg]}\n    if [ "${cached[$pkg]}" != "$candidate" ]; then pins+=("${pkg}=${cached[$pkg]}"); fi',
    ),
    "failed download pins a current-set file and a newer sibling to the manifest versions",
  ],
  [
    "fallback warning names every pinned package",
    replacePipeline("install", 'if [ "${cached[$pkg]}" != "$candidate" ]; then', "if true; then"),
    "failed download pins a current-set file and a newer sibling to the manifest versions",
  ],
  [
    "empty stale warning branch deleted",
    replacePipeline("install", 'else\n  echo "::warning::$warning"\n', ""),
    "failed download with matching versions warns without candidate text",
  ],
  [
    "verify check error continues instead of discarding",
    replacePipeline("verify", "else\n      return 1", "else\n      continue"),
    "verify discards every restored file on a check error",
  ],
  [
    "helper accepts a size mismatch",
    replacePipeline("helper", '[ "$actual_size" != "$size" ]', "false"),
    "size mismatch prints the no-usable-set error and never calls apt",
  ],
  [
    "helper accepts a checksum mismatch",
    replacePipeline("helper", '[ "$digest" != "${checksum#*:}" ]', "false"),
    "checksum mismatch prints the no-usable-set error and never calls apt",
  ],
  [
    "missing cached file is skipped",
    replacePipeline("install", 'reason="cached file $name is missing"\n      return 1', "continue"),
    "missing cached file prints the no-usable-set error and never calls apt",
  ],
  [
    "missing manifest is treated as empty",
    replacePipeline(
      "install",
      'if [ ! -r "$manifest" ]; then reason="restored manifest is missing"; return 1; fi\n',
      "",
    ),
    "missing manifest prints the no-usable-set error and never calls apt",
  ],
  [
    "malformed manifest line is skipped",
    replacePipeline("install", 'reason="malformed manifest line"\n      return 1', "continue"),
    "malformed manifest line prints the no-usable-set error and never calls apt",
  ],
  [
    "current name without a cached version is skipped",
    replacePipeline("install", 'if [ -z "${cached[$pkg]:-}" ]; then', "if false; then"),
    "current name without a manifest entry prints the no-usable-set error and never calls apt",
  ],
  [
    "dpkg-deb failure is ignored",
    replacePipeline(
      "install",
      'pkg=$(dpkg-deb -f "$file" Package) || { reason="cannot read Package from $name"; return 1; }',
      "pkg=alpha",
    ),
    "dpkg-deb failure prints the no-usable-set error and never calls apt",
  ],
  [
    "fallback apt failure loses its error",
    replacePipeline(
      "install",
      'echo "::error::linux-desktop-deps: installing the cached package set failed"\n',
      "",
    ),
    "fallback apt failure prints the install-failed error with apt's status",
  ],
];

test("linux-desktop-deps verify then install fallback behaves when executed", async (t) => {
  const { deps } = await readCiWorkflowTexts();
  const parts = pipelineParts(deps);
  assert.deepEqual(failedPipelineCases(parts), []);
  for (const [label, mutate, expected] of pipelineMutations)
    await t.test(label, (subtest) =>
      assertMutationRed({
        original: parts,
        mutate,
        failedFor: failedPipelineCases,
        expected,
        report: (failed) => subtest.diagnostic(`red: ${failed.join(" | ")}`),
      }),
    );
});
