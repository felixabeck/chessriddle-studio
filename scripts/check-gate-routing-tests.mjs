import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
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
  "pnpm mutation:guard:check && pnpm lint:ci && pnpm tauri:boundary:check && pnpm rust:surface:check && pnpm ui:boundary:check && pnpm skills:check && pnpm skills:bridges:test && pnpm gates:routing:check && pnpm gates:routing:test && pnpm ci:remote:test && pnpm tools:parity:check && pnpm tools:parity:test && pnpm workflows:check && pnpm workflows:permissions:test && pnpm ui:boundary:report:test && pnpm coverage:report:test && pnpm bundle:report:test && pnpm mutation:runner:test && pnpm rust:target:evict:test && pnpm gates:receipt:test && pnpm gates:logs:test && pnpm gates:parallelism:test && pnpm gates:push:test && pnpm gates:child-supervisor:test && pnpm gates:imports:test && pnpm rust:windows:test && pnpm entrypoint:test && pnpm e2e:launchers:test && pnpm install:local:test && pnpm app:driver:test && ./scripts/findings.py check && pnpm ipc:consumers:check";

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
        "gates:push":
          'bash "$HOME/.claude/scripts/push-lock.sh" gate -- agent-gate node scripts/run-push-gates.mjs',
        "checks:pre-review": "agent-gate node scripts/run-push-gates.mjs --pre-review",
        "gates:child-supervisor:test": "node --test scripts/child-supervisor-tests.mjs",
        "gates:imports:test": "node --test scripts/import-path-tests.mjs",
        "mutation:guard:check": "true",
        "rust:target:evict": "node scripts/rust-target-eviction.mjs",
        "findings:kit:check": "env -u KIT_ROOT kit sync --check .",
        "gate:ensure": "agent-gate node scripts/gate-receipt.mjs ensure",
        "gate:run": "agent-gate node scripts/gate-receipt.mjs run",
        "gate:check": "node scripts/gate-receipt.mjs check",
        "rust:windows:check": "true",
        "test:coverage": "true",
        "coverage:frontend:check": "true",
        "coverage:mapping:frontend": "true",
        "build-vite": "true",
        "bindings:check": "true",
        "bundle:check": "true",
        "test:e2e:container": "true",
        "mutation:frontend": "true",
        "test:coverage:backend": "true",
        "coverage:backend:check": "true",
        "coverage:mapping:backend": "true",
      },
    }),
  );
  await write(
    root,
    ".claude/skills/push/SKILL.md",
    "## 2. Gates\n\n```bash\npnpm gates:push -- <blocks>\n```\n\n### Unconditional contract gate\n\n```bash\npnpm gates:contract:check\n```\n\n### Rust/Tauri backend\n\n```bash\nbash scripts/setup-rust.sh\ncargo fmt --manifest-path src-tauri/Cargo.toml -- --check\ncargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings\npnpm rust:windows:check\npnpm gate:ensure backend-test\npnpm gate:ensure backend-coverage\n```\n\n### TypeScript/React frontend\n\n```bash\npnpm gate:ensure frontend-coverage\npnpm gate:ensure frontend-mutation\npnpm gate:run frontend-build\npnpm bundle:check\npnpm gate:ensure e2e-container\n```\n\n### Cross-layer contracts\n\n```bash\npnpm bindings:check\n```\n\n### Findings ledger\n\n```bash\nenv -u KIT_ROOT pnpm findings:kit:check\n```\n\n## 2a. Pre-review checks\n\n```bash\npnpm checks:pre-review\n```\n\n```bash\npnpm gate:run frontend-build\npnpm exec oxfmt --check <changed-format-files>\npnpm exec oxlint --deny-warnings <changed-js-ts-files>\npnpm exec tsgo --noEmit\ncargo fmt --manifest-path src-tauri/Cargo.toml -- --check\npnpm coverage:mapping:frontend\npnpm coverage:mapping:backend\npnpm rust:windows:check\npnpm bundle:check\n```\n\n## 3. Review\n\n```text\nscripts/**\n```\n\n## 4. Finish\n",
  );
  await write(
    root,
    ".github/workflows/test.yml",
    "steps:\n  - name: Contract\n    run: pnpm gates:contract:check\n  - name: Frontend coverage\n    run: pnpm test:coverage\n  - name: Frontend ratchet\n    run: pnpm coverage:frontend:check\n  - name: Frontend build\n    run: pnpm build-vite\n  - name: Bindings\n    run: pnpm bindings:check\n  - name: Bundle\n    run: pnpm bundle:check\n  - name: Browser\n    run: pnpm test:e2e:container\n  - name: Mutation\n    run: pnpm mutation:frontend\n  - name: Rust gates\n    run: |\n      cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings\n  - name: Backend coverage\n    run: pnpm test:coverage:backend\n  - name: Backend ratchet\n    run: pnpm coverage:backend:check\n",
  );
  const skillPath = join(root, ".claude/skills/push/SKILL.md");
  const skill = await readFile(skillPath, "utf8");
  await writeFile(
    skillPath,
    skill.replace(
      "## 3. Review",
      "### Gate receipts\n\n```bash\npnpm gate:check frontend-build\n```\n\n## 3. Review",
    ),
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

test("heavy gate package scripts preserve the strict agent-gate wrapper and pre-review mode", async (t) => {
  const cases = [
    {
      title: "gates:push without the wrapper is rejected",
      script: "gates:push",
      replacement: "node scripts/run-push-gates.mjs",
      expected:
        /package\.json gates:push must invoke bash "\$HOME\/\.claude\/scripts\/push-lock\.sh" gate -- agent-gate node scripts\/run-push-gates\.mjs/u,
    },
    {
      title: "gates:push without the push lock is rejected",
      script: "gates:push",
      replacement: "agent-gate node scripts/run-push-gates.mjs",
      expected:
        /package\.json gates:push must invoke bash "\$HOME\/\.claude\/scripts\/push-lock\.sh" gate -- agent-gate node scripts\/run-push-gates\.mjs/u,
    },
    {
      title: "checks:pre-review without --pre-review is rejected",
      script: "checks:pre-review",
      replacement: "agent-gate node scripts/run-push-gates.mjs",
      expected:
        /package\.json checks:pre-review must invoke agent-gate node scripts\/run-push-gates\.mjs --pre-review/u,
    },
    {
      title: "gate:ensure without the wrapper is rejected",
      script: "gate:ensure",
      replacement: "node scripts/gate-receipt.mjs ensure",
      expected:
        /package\.json gate:ensure must invoke agent-gate node scripts\/gate-receipt\.mjs ensure/u,
    },
    {
      title: "gate:run without the wrapper is rejected",
      script: "gate:run",
      replacement: "node scripts/gate-receipt.mjs run",
      expected:
        /package\.json gate:run must invoke agent-gate node scripts\/gate-receipt\.mjs run/u,
    },
    {
      title: "gates:push with a command -v fallback is rejected",
      script: "gates:push",
      replacement:
        "if command -v agent-gate >/dev/null 2>&1; then agent-gate node scripts/run-push-gates.mjs; else node scripts/run-push-gates.mjs; fi",
      expected:
        /package\.json gates:push must invoke bash "\$HOME\/\.claude\/scripts\/push-lock\.sh" gate -- agent-gate node scripts\/run-push-gates\.mjs/u,
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

test("reports unknown receipt names for every receipt verb", async () => {
  for (const verb of ["ensure", "run", "check"]) {
    const root = await fixture();
    const skillPath = join(root, ".claude/skills/push/SKILL.md");
    await writeFile(
      skillPath,
      `${await readFile(skillPath, "utf8")}\n\`\`\`bash\npnpm gate:${verb} absent-gate\n\`\`\`\n`,
    );
    assert.match(
      (await checkGateRouting(root, { paths })).join("\n"),
      new RegExp(`unknown receipt gate absent-gate.*pnpm gate:${verb} absent-gate`, "u"),
    );
  }
});

test("resolves nested package scripts through every receipt verb", async () => {
  for (const verb of ["ensure", "run", "check"]) {
    const root = await fixture();
    const packagePath = join(root, "package.json");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
    packageJson.scripts["build-vite"] = "pnpm receipt:nested:check";
    packageJson.scripts["receipt:nested:check"] = "node scripts/receipt-nested.mjs";
    await writeFile(packagePath, JSON.stringify(packageJson));
    const skillPath = join(root, ".claude/skills/push/SKILL.md");
    await writeFile(
      skillPath,
      `${await readFile(skillPath, "utf8")}\n\`\`\`bash\npnpm gate:${verb} frontend-build\n\`\`\`\n`,
    );
    assert.deepEqual(await checkGateRouting(root, { paths }), [], `${verb} did not expand`);
  }
});

test("resolves a script reached only through a receipt", async () => {
  const root = await fixture();
  const packagePath = join(root, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.scripts["build-vite"] = "pnpm receipt-only:check";
  packageJson.scripts["receipt-only:check"] = "node scripts/receipt-only.mjs";
  await writeFile(packagePath, JSON.stringify(packageJson));
  const skillPath = join(root, ".claude/skills/push/SKILL.md");
  await writeFile(
    skillPath,
    `${await readFile(skillPath, "utf8")}\n\`\`\`bash\npnpm gate:ensure frontend-build\n\`\`\`\n`,
  );
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
      "    run: pnpm mutation:frontend",
      "    if: github.ref == 'refs/heads/master'\n    run: pnpm mutation:frontend",
    )}  - name: Upload\n    if: always()\n    uses: actions/upload-artifact@v4\n`,
  );
  const findings = (await checkGateRouting(root, { paths })).join("\n");
  assert.match(findings, /workflow step has if: "github\.ref == 'refs\/heads\/master'": Mutation/u);
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
      "    run: pnpm mutation:frontend",
      "    continue-on-error: true\n    run: pnpm mutation:frontend",
    ),
  );
  assert.match(
    (await checkGateRouting(root, { paths })).join("\n"),
    /workflow step ignores the gate's exit status with continue-on-error: "true": Mutation/u,
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
    workflow.replace("run: pnpm mutation:frontend", "run: pnpm mutation:frontend --list-packages"),
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

test("reports a stale path-scoped CI map key absent from the workflow", async () => {
  const root = await fixture();
  const workflowPath = join(root, ".github/workflows/test.yml");
  const workflow = await readFile(workflowPath, "utf8");
  await writeFile(
    workflowPath,
    workflow.replace("  - name: Mutation\n    run: pnpm mutation:frontend\n", ""),
  );
  assert.match(
    (await checkGateRouting(root, { paths })).join("\n"),
    /CI_REQUIRED_SCRIPTS key mutation:frontend is absent/u,
  );
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
  await writeFile(
    skillPath,
    skill.replace(/^```bash\n[\s\S]*?^```\n/gmu, "") +
      "\n```bash\npnpm gate:check frontend-build\n```\n",
  );
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
  for (const [label, collection] of [
    ["test", testJobs],
    ["sweep", sweepJobs],
  ]) {
    const listing = collection.get("frontend-mutation-packages");
    const matrix = collection.get("frontend-mutation");
    requireText(
      `${label} listing command`,
      listing,
      'run: echo "ids=$(node scripts/run-frontend-mutation.mjs --list-packages)" >> "$GITHUB_OUTPUT"',
    );
    requireText(`${label} listing output`, listing, "ids: ${{ steps.list.outputs.ids }}");
    requireText(`${label} listing id`, listing, "id: list");
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
      "id: dates",
      "today=$(date -u +%Y%m%d)",
      'echo "today=$today" >> "$GITHUB_OUTPUT"',
    ])
      requireText(`${label} ${value}`, matrix, value);
    contracts.push([
      `${label} dates before cache`,
      () => assert.ok(matrix.indexOf("id: dates") < matrix.indexOf("uses: actions/cache/")),
    ]);
  }
  const matrix = testJobs.get("frontend-mutation");
  requireText(
    "change base",
    matrix,
    "FRONTEND_MUTATION_CHANGED_SINCE: ${{ github.event_name == 'push' && github.event.before || github.event_name == 'pull_request' && github.event.pull_request.base.sha || '' }}",
  );
  requireText(
    "yesterday UTC",
    matrix,
    'echo "yesterday=$(date -u -d "$today -1 day" +%Y%m%d)" >> "$GITHUB_OUTPUT"',
  );
  requireText("restore only", matrix, "uses: actions/cache/restore@v4");
  forbid("no push save or combined cache", texts.test, /uses: actions\/cache(?:\/save)?@/u);
  requireText(
    "unmatched restore key",
    matrix,
    "key: frontend-mutation-restore-${{ matrix.package }}-${{ github.run_id }}-${{ github.run_attempt }}",
  );
  requireText(
    "exact dated prefixes",
    matrix,
    "restore-keys: |\n            frontend-mutation-full-${{ matrix.package }}-${{ steps.dates.outputs.today }}-\n            frontend-mutation-full-${{ matrix.package }}-${{ steps.dates.outputs.yesterday }}-\n\n",
  );
  requireText("restore directory", matrix, "path: .frontend-mutation-incremental");
  const sweep = sweepJobs.get("frontend-mutation");
  requireText("force full sweep", sweep, 'FRONTEND_MUTATION_FORCE: "1"');
  forbid("no sweep change base", sweep, /FRONTEND_MUTATION_CHANGED_SINCE/u);
  forbid("no sweep restore", sweep, /uses: actions\/cache(?:\/restore)?@/u);
  requireText("success-only save", sweep, "if: success()\n        uses: actions/cache/save@v4");
  requireText(
    "dated save key",
    sweep,
    "key: frontend-mutation-full-${{ matrix.package }}-${{ steps.dates.outputs.today }}-${{ github.run_id }}",
  );
  requireText("save directory", sweep, "path: .frontend-mutation-incremental");
  contracts.push([
    "save after mutation",
    () =>
      assert.ok(
        sweep.indexOf("run: pnpm mutation:frontend") < sweep.indexOf("uses: actions/cache/save@v4"),
      ),
  ]);
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
  for (const name of ["frontend", "e2e", "rust", "frontend-mutation"]) {
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
  const cachePath = depsStep("restore")?.withValues.get("path");
  const archives = /^(\/tmp\/[\w./-]+)\/\*\.deb$/u.exec(cachePath ?? "")?.[1];
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
    "deps cache paths are the archive directory's .deb files",
    () => assert.ok(archives, "deps cache paths are the archive directory's .deb files"),
  ]);
  pinDepsStep("deps restore and save share one cache path", "save", (step) =>
    assert.equal(
      step.withValues.get("path"),
      cachePath,
      "deps restore and save share one cache path",
    ),
  );
  forbid(
    "deps archive directory is not a mktemp path",
    depsSteps.map((step) => step.text).join("\n"),
    /mktemp/u,
  );
  for (const [label, id, needle] of [
    ["deps resolve passes the cache path directory to apt", "resolve", "install --print-uris"],
    ["deps download passes the cache path directory to apt", "download", "install --download-only"],
    ["deps install passes the cache path directory to apt", "install", "install --no-download"],
  ])
    pinDepsStep(label, id, (step) =>
      assert.ok(
        archives && step.text.includes(`-o Dir::Cache::Archives=${archives} ${needle}`),
        label,
      ),
    );
  // The cache population chain: verify and prune exist, their producers feed the save guard, and
  // restore and save agree on the keys.
  pinDepsStep("deps has a verify step", "verify", () => {});
  // The verify step's working lines: the checksum-type dispatch, both drops and the error discard.
  const dropBranch = (opener, echoed) =>
    `            ${opener}\n              echo "linux-desktop-deps: dropping restored $name: ${echoed}"\n              rm -f -- "$file"`;
  for (const [label, needle] of [
    ["deps verify dispatches on the checksum type", 'case "${checksum%%:*}" in'],
    ["deps verify handles MD5Sum", "MD5Sum) tool=md5sum ;;"],
    ["deps verify handles SHA256", "SHA256) tool=sha256sum ;;"],
    [
      "deps verify drops a size mismatch",
      dropBranch('if [ "$actual_size" != "$size" ]; then', "size $actual_size, expected $size"),
    ],
    [
      "deps verify drops a checksum mismatch",
      dropBranch(
        'elif [ "$digest" != "${checksum#*:}" ]; then',
        "${checksum%%:*} $digest, expected ${checksum#*:}",
      ),
    ],
    [
      "deps verify discards every file on a verification error",
      "find \"$archives\" -maxdepth 1 -name '*.deb' -delete",
    ],
  ])
    pinDepsStep(label, "verify", (step) => assert.ok(step.text.includes(needle), label));
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
    "deps save comes before install",
    () => {
      const ids = depsSteps.map((step) => step.id);
      assert.ok(
        ids.includes("save") && ids.indexOf("save") < ids.indexOf("install"),
        "deps save comes before install",
      );
    },
  ]);
  // The bound chain, step-scoped to the resolve step that owns the sourced helpers.
  pinDepsStep("deps resolve maps timeout-minutes to TIMEOUT_MINUTES", "resolve", (step) =>
    assert.ok(
      step.text.includes(
        "      env:\n        TIMEOUT_MINUTES: ${{ inputs.timeout-minutes }}\n      run:",
      ),
      "deps resolve maps timeout-minutes to TIMEOUT_MINUTES",
    ),
  );
  // The stall label and the pieces that decide when it prints, each pinned on its own line.
  for (const [label, needle] of [
    [
      "deps helper labels the expiry as a mirror stall",
      "mirror stall: apt-get $1 was stopped after",
    ],
    [
      "deps helper never labels an unbounded run",
      'if [ -z "$LINUX_DESKTOP_DEPS_DEADLINE" ] || [ "$LINUX_DESKTOP_DEPS_BOUND" -le 0 ]; then return 0; fi',
    ],
    ["deps helper labels a failed apt command", 'desktop_deps_label_stall "$phase" "$rc"'],
    ["deps helper labels a used-up bound", "bound is used up"],
    [
      "deps resolve derives the deadline from start and bound",
      "LINUX_DESKTOP_DEPS_DEADLINE=$((LINUX_DESKTOP_DEPS_START + bound))",
    ],
    [
      "deps helper computes remaining from the deadline",
      "remaining=$((LINUX_DESKTOP_DEPS_DEADLINE - now))",
    ],
  ])
    pinDepsStep(label, "resolve", (step) => assert.ok(step.text.includes(needle), label));
  // The deadline variables reach the later steps only through GITHUB_ENV.
  for (const name of ["START", "BOUND", "DEADLINE"])
    pinDepsStep(`deps resolve exports LINUX_DESKTOP_DEPS_${name}`, "resolve", (step) =>
      assert.ok(
        step.text.includes(`echo "LINUX_DESKTOP_DEPS_${name}=$LINUX_DESKTOP_DEPS_${name}"\n`),
        `deps resolve exports LINUX_DESKTOP_DEPS_${name}`,
      ),
    );
  pinDepsStep("deps resolve writes the deadline variables to GITHUB_ENV", "resolve", (step) =>
    assert.ok(
      step.text.includes(
        '        {\n          echo "LINUX_DESKTOP_DEPS_START=$LINUX_DESKTOP_DEPS_START"\n          echo "LINUX_DESKTOP_DEPS_BOUND=$LINUX_DESKTOP_DEPS_BOUND"\n          echo "LINUX_DESKTOP_DEPS_DEADLINE=$LINUX_DESKTOP_DEPS_DEADLINE"\n        } >> "$GITHUB_ENV"',
      ),
      "deps resolve writes the deadline variables to GITHUB_ENV",
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
  pinDepsStep("deps helper runs apt under sudo timeout --kill-after", "resolve", (step) =>
    assert.ok(
      step.text.includes(
        'sudo timeout --kill-after="$kill_grace" "$remaining" apt-get "$@" || rc=$?',
      ),
      "deps helper runs apt under sudo timeout --kill-after",
    ),
  );
  pinDepsStep("deps helper keeps the unbounded sudo apt-get form", "resolve", (step) =>
    assert.ok(
      step.text.includes('\n            sudo apt-get "$@" || rc=$?\n'),
      "deps helper keeps the unbounded sudo apt-get form",
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

// Names of the contracts that fail for the given workflow texts.
function failedContracts(texts) {
  return ciWorkflowContracts(texts).flatMap(([name, check]) => {
    try {
      check();
      return [];
    } catch {
      return [name];
    }
  });
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
const depsSaveStepFragment = `path: ${depsArchives}/*.deb\n        key: ${"$"}{{ steps.resolve.outputs.save-key }}\n\n`;
const depsRestoreStepFragment = `path: ${depsArchives}/*.deb\n        key: ${"$"}{{ steps.resolve.outputs.save-key }}\n        restore-keys`;
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
    "deps cache paths are the archive directory's .deb files",
  ],
  [
    "resolve loses the archive directory",
    "deps",
    `apt-get -o Dir::Cache::Archives=${depsArchives} install --print-uris`,
    "apt-get install --print-uris",
    "deps resolve passes the cache path directory to apt",
  ],
  [
    "download uses another archive directory",
    "deps",
    `download_args=(-o Dir::Cache::Archives=${depsArchives}`,
    "download_args=(-o Dir::Cache::Archives=/tmp/other-archives",
    "deps download passes the cache path directory to apt",
  ],
  [
    "install loses the archive directory",
    "deps",
    `apt-get -o Dir::Cache::Archives=${depsArchives} install --no-download`,
    "apt-get install --no-download",
    "deps install passes the cache path directory to apt",
  ],
  [
    "archive directory from mktemp",
    "deps",
    `archives=${depsArchives}\n        lib=`,
    "archives=$(mktemp -d)\n        lib=",
    "deps archive directory is not a mktemp path",
  ],
  [
    "helper loses sudo timeout",
    "deps",
    'sudo timeout --kill-after="$kill_grace" "$remaining" apt-get "$@" || rc=$?',
    'sudo apt-get "$@" || rc=$?',
    "deps helper runs apt under sudo timeout --kill-after",
  ],
  [
    "helper loses sudo before timeout",
    "deps",
    'sudo timeout --kill-after="$kill_grace" "$remaining" apt-get "$@" || rc=$?',
    'timeout --kill-after="$kill_grace" "$remaining" apt-get "$@" || rc=$?',
    "deps helper runs apt under sudo timeout --kill-after",
  ],
  [
    "helper loses the unbounded form",
    "deps",
    '            sudo apt-get "$@" || rc=$?\n',
    '            apt-get "$@" || rc=$?\n',
    "deps helper keeps the unbounded sudo apt-get form",
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
    "helper loses the unbounded guard",
    "deps",
    '          if [ -z "$LINUX_DESKTOP_DEPS_DEADLINE" ] || [ "$LINUX_DESKTOP_DEPS_BOUND" -le 0 ]; then return 0; fi\n',
    "",
    "deps helper never labels an unbounded run",
  ],
  [
    "helper loses the expiry label",
    "deps",
    /^( +)echo "::error::[^\n]*was stopped after[^\n]*\n/gmu,
    "$1:\n",
    "deps helper labels the expiry as a mirror stall",
  ],
  [
    "helper loses the label call",
    "deps",
    '          if [ "$rc" -ne 0 ]; then desktop_deps_label_stall "$phase" "$rc"; fi\n',
    "",
    "deps helper labels a failed apt command",
  ],
  [
    "helper loses the used-up label",
    "deps",
    /^( +)echo "::error::[^\n]*bound is used up[^\n]*\n/gmu,
    "$1:\n",
    "deps helper labels a used-up bound",
  ],
  [
    "deadline ignores the bound",
    "deps",
    "LINUX_DESKTOP_DEPS_DEADLINE=$((LINUX_DESKTOP_DEPS_START + bound))",
    "LINUX_DESKTOP_DEPS_DEADLINE=$LINUX_DESKTOP_DEPS_START",
    "deps resolve derives the deadline from start and bound",
  ],
  [
    "remaining ignores the deadline",
    "deps",
    "remaining=$((LINUX_DESKTOP_DEPS_DEADLINE - now))",
    "remaining=$((LINUX_DESKTOP_DEPS_START - now))",
    "deps helper computes remaining from the deadline",
  ],
  [
    "start not exported",
    "deps",
    '          echo "LINUX_DESKTOP_DEPS_START=$LINUX_DESKTOP_DEPS_START"\n',
    "",
    "deps resolve exports LINUX_DESKTOP_DEPS_START",
  ],
  [
    "bound not exported",
    "deps",
    '          echo "LINUX_DESKTOP_DEPS_BOUND=$LINUX_DESKTOP_DEPS_BOUND"\n',
    "",
    "deps resolve exports LINUX_DESKTOP_DEPS_BOUND",
  ],
  [
    "deadline not exported",
    "deps",
    '          echo "LINUX_DESKTOP_DEPS_DEADLINE=$LINUX_DESKTOP_DEPS_DEADLINE"\n',
    "",
    "deps resolve exports LINUX_DESKTOP_DEPS_DEADLINE",
  ],
  [
    "deadline variables go to GITHUB_OUTPUT",
    "deps",
    '        } >> "$GITHUB_ENV"',
    '        } >> "$GITHUB_OUTPUT"',
    "deps resolve writes the deadline variables to GITHUB_ENV",
  ],
  [
    "verify step id lost",
    "deps",
    "      id: verify\n",
    "      id: checked\n",
    "deps has a verify step",
  ],
  [
    "verify dispatch removed",
    "deps",
    'case "${checksum%%:*}" in',
    "case MD5Sum in",
    "deps verify dispatches on the checksum type",
  ],
  [
    "verify loses the MD5Sum arm",
    "deps",
    "              MD5Sum) tool=md5sum ;;\n",
    "",
    "deps verify handles MD5Sum",
  ],
  [
    "verify loses the SHA256 arm",
    "deps",
    "              SHA256) tool=sha256sum ;;\n",
    "",
    "deps verify handles SHA256",
  ],
  [
    "verify stops dropping a size mismatch",
    "deps",
    'if [ "$actual_size" != "$size" ]; then',
    "if false; then",
    "deps verify drops a size mismatch",
  ],
  [
    "verify stops dropping a checksum mismatch",
    "deps",
    'elif [ "$digest" != "${checksum#*:}" ]; then',
    "elif false; then",
    "deps verify drops a checksum mismatch",
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
    "deps verify dispatches on the checksum type",
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
];

test("CI workflow wiring rejects removed selectors, checkout, freshness, publication and dist prerequisites", async (t) => {
  const texts = await readCiWorkflowTexts();
  // A row with a fifth element must turn at least that labelled contract red (other contracts may
  // legitimately fail too); the older rows only need some contract to fail.
  for (const [label, file, before, afterText = "", contract] of [
    ["matrix package env", "test", "      FRONTEND_MUTATION_PACKAGE: ${{ matrix.package }}\n"],
    ["fetch full history", "test", "          fetch-depth: 0"],
    ["restore action", "test", "uses: actions/cache/restore@v4"],
    [
      "dated prefixes",
      "test",
      "frontend-mutation-full-${{ matrix.package }}-${{ steps.dates.outputs.yesterday }}-",
    ],
    ["forbid push save", "test", "uses: actions/cache/restore@v4", "uses: actions/cache/save@v4"],
    ["forced sweep", "sweep", '      FRONTEND_MUTATION_FORCE: "1"\n'],
    ["success-only publication", "sweep", "        if: success()\n"],
    [
      "dated publication",
      "sweep",
      "key: frontend-mutation-full-${{ matrix.package }}-${{ steps.dates.outputs.today }}-${{ github.run_id }}",
    ],
    ["dist missing", "test", "        run: mkdir -p dist\n"],
    [
      "dist too late",
      "test",
      "        run: mkdir -p dist",
      "        run: cargo fmt --manifest-path src-tauri/Cargo.toml -- --check\n      - name: Late distribution directory\n        run: mkdir -p dist",
    ],
    [
      "listing disconnected",
      "test",
      "package: ${{ fromJSON(needs.frontend-mutation-packages.outputs.ids) }}",
    ],
    ["change base removed", "test", "github.event.pull_request.base.sha", "''"],
    ...linuxDesktopDepsRows,
  ]) {
    await t.test(label, () => {
      // Disposable strings exercise the same assertions used above, without touching the checkout.
      const changed = { ...texts, [file]: texts[file].replaceAll(before, afterText) };
      assert.notEqual(changed[file], texts[file]);
      const failed = failedContracts(changed);
      if (contract) assert.ok(failed.includes(contract), `${contract} stayed green: ${failed}`);
      else assert.ok(failed.length > 0);
    });
  }
  await t.test("save moved after install", () => {
    const start = texts.deps.indexOf("    # Save only a set");
    const end = texts.deps.indexOf("    # `--no-download`");
    assert.ok(start > 0 && end > start);
    const moved = texts.deps.slice(0, start) + texts.deps.slice(end) + texts.deps.slice(start, end);
    assert.deepEqual(failedContracts({ ...texts, deps: moved }), [
      "deps save comes before install",
    ]);
  });
});
