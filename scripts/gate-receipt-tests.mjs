import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, writeSync } from "node:fs";
import { mkdir, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { once } from "node:events";
import { fencedBlocks } from "./check-gate-routing.mjs";
import { executeAction, GATES, REQUIRED_TOOLS, TOOL_PROBES } from "./gate-receipt.mjs";
import {
  GATE_LOG_DIRECTORY_ENV,
  LOG_TAIL_BYTES,
  makeLogDirectory,
  readLogTail,
  transcriptFileName,
} from "./gate-logs.mjs";
import { testTempRoots } from "./test-temp-root.mjs";

const temporaryRoot = testTempRoots(after);

// The push-gate scheduler exports its own run directory to this lane; fixtures must not inherit it.
delete process.env[GATE_LOG_DIRECTORY_ENV];

const EXPECTED_GATES = {
  "backend-test": "cargo test --manifest-path src-tauri/Cargo.toml --all-targets",
  "backend-coverage": "pnpm test:coverage:backend && pnpm coverage:backend:check",
  "frontend-coverage": "pnpm test:coverage && pnpm coverage:frontend:check",
  "frontend-mutation": "pnpm mutation:frontend",
  "frontend-build": "pnpm build-vite",
  "e2e-container": "pnpm test:e2e:container",
  "tauri-build": "pnpm build",
};
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function runGit(root, ...argumentsList) {
  const result = spawnSync("git", argumentsList, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

async function fixture() {
  const directory = await temporaryRoot("gate-receipt-test-");
  const root = join(directory, "repo");
  await mkdir(root);
  runGit(root, "init", "--quiet");
  await writeFile(join(root, ".gitignore"), ".gate-receipts/\nartifacts/\n");
  await writeFile(join(root, "tracked.txt"), "initial\n");
  runGit(root, "add", ".gitignore", "tracked.txt");
  runGit(
    root,
    "-c",
    "user.name=Gate Receipt Test",
    "-c",
    "user.email=gate-receipt@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  await utimes(join(root, "tracked.txt"), new Date(0), new Date(0));
  return { directory, root };
}

function fakeToolchain(version = "one") {
  return () => ({ fake: version });
}

function nodeCommand(source) {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
}

function silentOutput() {
  return { error() {}, log() {} };
}

async function record(root, options = {}) {
  return await executeAction({
    action: "run",
    gate: "frontend-build",
    repoRoot: root,
    fingerprintToolchain: fakeToolchain(),
    command: nodeCommand("process.exit(0)"),
    output: silentOutput(),
    ...options,
  });
}

for (const gate of ["frontend-mutation", "e2e-container", "frontend-coverage"]) {
  test(`${gate} receipt tree scope across committed records and other inputs`, async () => {
    const { root } = await fixture();
    const findings = join(root, "tasks/findings.md");
    await mkdir(dirname(findings), { recursive: true });
    await writeFile(findings, "initial records\n");
    const commit = () => {
      runGit(root, "add", "-A");
      runGit(
        root,
        "-c",
        "user.name=Gate Receipt Test",
        "-c",
        "user.email=gate-receipt@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "inputs",
      );
    };
    const check = () =>
      executeAction({
        action: "check",
        gate,
        repoRoot: root,
        fingerprintToolchain: fakeToolchain(),
        command: nodeCommand("process.exit(0)"),
        output: silentOutput(),
      });
    commit();
    assert.equal(await record(root, { gate }), 0);
    assert.equal(await check(), 0);
    await writeFile(findings, "updated records\n");
    await mkdir(join(root, "tasks/handoffs"));
    await writeFile(join(root, "tasks/handoffs/x.md"), "handoff\n");
    commit();
    assert.equal(await check(), gate === "frontend-coverage" ? 1 : 0);

    for (const path of ["src/x.ts", "src-tauri/capabilities/main.json", "docs/x.md"]) {
      assert.equal(await record(root, { gate }), 0);
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), "changed input\n");
      commit();
      assert.equal(await check(), 1, path);
    }

    assert.equal(await record(root, { gate }), 0);
    await writeFile(findings, "dirty records\n");
    assert.equal(await check(), 1);
  });

  test(`${gate} refuses a receipt when tasks change during the run`, async () => {
    const { root } = await fixture();
    const findings = join(root, "tasks/findings.md");
    await mkdir(dirname(findings));
    await writeFile(findings, "initial records\n");
    runGit(root, "add", "tasks");
    runGit(
      root,
      "-c",
      "user.name=Gate Receipt Test",
      "-c",
      "user.email=gate-receipt@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "records",
    );
    const command = nodeCommand(
      `const fs = require("node:fs"); const path = ${JSON.stringify(findings)}; fs.writeFileSync(path, "changed"); fs.writeFileSync(path, "initial records\\n");`,
    );
    assert.equal(await record(root, { gate, command }), 3);
    assert.equal(existsSync(join(root, ".gate-receipts", `${gate}.json`)), false);
  });
}

test("registry maps all seven gates to their exact command strings", () => {
  assert.deepEqual(GATES, EXPECTED_GATES);
});

test("every gate child strips all FRONTEND_MUTATION_ keys while preserving other environment", async () => {
  const { root } = await fixture();
  const env = {
    ...process.env,
    FRONTEND_MUTATION_PACKAGE: "game-practice",
    FRONTEND_MUTATION_CHANGED_SINCE: "a".repeat(40),
    FRONTEND_MUTATION_INCREMENTAL_DIR: "/tmp/cache",
    FRONTEND_MUTATION_FORCE: "1",
    FRONTEND_MUTATION_FUTURE: "also stripped",
    RECEIPT_ENV_KEEP: "kept",
  };
  for (const gate of Object.keys(GATES)) {
    const status = await record(root, {
      gate,
      env,
      command: nodeCommand(
        "if (Object.keys(process.env).some(key => key.startsWith('FRONTEND_MUTATION_')) || process.env.RECEIPT_ENV_KEEP !== 'kept') process.exit(9)",
      ),
    });
    assert.equal(status, 0, gate);
  }
  assert.equal(env.FRONTEND_MUTATION_PACKAGE, "game-practice");
  assert.equal(env.FRONTEND_MUTATION_FUTURE, "also stripped");
});

test("every gate fingerprints a pinned tool set, and every listed tool has a probe", () => {
  assert.deepEqual(Object.keys(REQUIRED_TOOLS).sort(), Object.keys(GATES).sort());
  assert.deepEqual(REQUIRED_TOOLS, {
    "backend-test": ["rustc", "cargo"],
    "backend-coverage": ["rustc", "cargo", "nightly", "cargo-llvm-cov", "node", "pnpm"],
    "frontend-coverage": ["node", "pnpm"],
    "frontend-mutation": ["node", "pnpm", "stryker"],
    "frontend-build": ["node", "pnpm"],
    "e2e-container": ["node", "pnpm", "playwright-image"],
    "tauri-build": ["rustc", "cargo", "node", "pnpm"],
  });
  for (const tools of Object.values(REQUIRED_TOOLS)) {
    for (const tool of tools) {
      assert.equal(typeof TOOL_PROBES[tool], "function", `missing probe for ${tool}`);
    }
  }
});

test("the push skill receipt fence names every registered gate", async () => {
  const skill = await readFile(join(projectRoot, ".claude", "skills", "push", "SKILL.md"), "utf8");
  const receiptsSection = skill.slice(
    skill.indexOf("### Gate receipts"),
    skill.indexOf("### Cross-layer contracts"),
  );
  const commands = fencedBlocks(receiptsSection)
    .map(({ contents }) => contents)
    .join("\n");
  for (const gate of Object.keys(GATES)) {
    assert.match(commands, new RegExp(`^pnpm gate:ensure ${gate}$`, "mu"));
  }
});

test("the frontend push gate fence includes frontend mutation", async () => {
  const skill = await readFile(join(projectRoot, ".claude", "skills", "push", "SKILL.md"), "utf8");
  const frontendSection = skill.slice(
    skill.indexOf("### TypeScript/React frontend"),
    skill.indexOf("### Gate receipts"),
  );
  const commands = fencedBlocks(frontendSection)
    .map(({ contents }) => contents)
    .join("\n");
  assert.match(commands, /^pnpm gate:ensure frontend-mutation$/mu);
});

test("frontend-build records a real node and pnpm fingerprint", async () => {
  const { root } = await fixture();
  assert.equal(
    await executeAction({
      action: "run",
      gate: "frontend-build",
      repoRoot: root,
      command: nodeCommand("process.exit(0)"),
      output: silentOutput(),
    }),
    0,
  );
  const receipt = JSON.parse(
    await readFile(join(root, ".gate-receipts", "frontend-build.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(receipt.toolchain).sort(), ["node", "pnpm"]);
  assert.equal(
    receipt.toolchain.node,
    execFileSync("node", ["--version"], { encoding: "utf8" }).trim(),
  );
  assert.equal(
    receipt.toolchain.pnpm,
    execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
  );
});

test("a repo git cannot observe refuses the receipt as unobservable, not as a tree change", async () => {
  const root = await temporaryRoot("gate-receipt-nongit-");
  const messages = [];
  assert.equal(
    await executeAction({
      action: "run",
      gate: "frontend-build",
      repoRoot: root,
      fingerprintToolchain: fakeToolchain(),
      command: nodeCommand("process.exit(0)"),
      output: {
        error(message) {
          messages.push(message);
        },
        log() {},
      },
    }),
    3,
  );
  assert.match(messages.join("\n"), /could not observe the tree/u);
  assert.doesNotMatch(messages.join("\n"), /tree changed during the gate/u);
});

test("a gate terminated by SIGTERM returns 143 and names the signal", async () => {
  const { root } = await fixture();
  const messages = [];
  assert.equal(
    await executeAction({
      action: "run",
      gate: "frontend-build",
      repoRoot: root,
      fingerprintToolchain: fakeToolchain(),
      // Replace the shell so the supervisor observes the gate's signal directly.
      command: `exec ${nodeCommand("process.kill(process.pid, 'SIGTERM')")}`,
      output: {
        error(message) {
          messages.push(message);
        },
        log() {},
      },
    }),
    143,
  );
  assert.match(messages.join("\n"), /gate failed: frontend-build \(exit 143, signal SIGTERM\)/u);
});

test("1. hit on a clean, unchanged tree", async () => {
  const { directory, root } = await fixture();
  const marker = join(directory, "runs.txt");
  const command = nodeCommand(
    `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "run\\n")`,
  );
  assert.equal(await record(root, { command }), 0);
  assert.equal(
    await executeAction({
      action: "ensure",
      gate: "frontend-build",
      repoRoot: root,
      fingerprintToolchain: fakeToolchain(),
      command,
      output: silentOutput(),
    }),
    0,
  );
  assert.equal(await readFile(marker, "utf8"), "run\n");
});

test("2. miss after a tracked file changes", async () => {
  const { root } = await fixture();
  assert.equal(await record(root), 0);
  await writeFile(join(root, "tracked.txt"), "committed change\n");
  runGit(root, "add", "tracked.txt");
  runGit(
    root,
    "-c",
    "user.name=Gate Receipt Test",
    "-c",
    "user.email=gate-receipt@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "change tree",
  );
  assert.equal(
    await executeAction({
      action: "check",
      gate: "frontend-build",
      repoRoot: root,
      fingerprintToolchain: fakeToolchain(),
      command: nodeCommand("process.exit(0)"),
      output: silentOutput(),
    }),
    1,
  );
});

test("3. miss on a dirty worktree", async () => {
  const { root } = await fixture();
  assert.equal(await record(root), 0);
  await writeFile(join(root, "untracked.txt"), "dirty\n");
  assert.equal(
    await executeAction({
      action: "check",
      gate: "frontend-build",
      repoRoot: root,
      fingerprintToolchain: fakeToolchain(),
      command: nodeCommand("process.exit(0)"),
      output: silentOutput(),
    }),
    1,
  );
});

test("4. miss on a changed toolchain fingerprint", async () => {
  const { root } = await fixture();
  assert.equal(await record(root), 0);
  assert.equal(
    await executeAction({
      action: "check",
      gate: "frontend-build",
      repoRoot: root,
      fingerprintToolchain: fakeToolchain("two"),
      command: nodeCommand("process.exit(0)"),
      output: silentOutput(),
    }),
    1,
  );
});

test("5. miss after TTL expiry", async () => {
  const { root } = await fixture();
  const createdAt = Date.parse("2026-08-30T00:00:00Z");
  assert.equal(await record(root, { now: () => createdAt }), 0);
  assert.equal(
    await executeAction({
      action: "check",
      gate: "frontend-build",
      repoRoot: root,
      now: () => createdAt + 1001,
      ttlMs: 1000,
      fingerprintToolchain: fakeToolchain(),
      command: nodeCommand("process.exit(0)"),
      output: silentOutput(),
    }),
    1,
  );
});

test("6. miss after the gate failed (no receipt written, gate's exit code propagated)", async () => {
  const { root } = await fixture();
  const status = await record(root, { command: nodeCommand("process.exit(23)") });
  assert.equal(status, 23);
  assert.equal(existsSync(join(root, ".gate-receipts", "frontend-build.json")), false);
});

test("7. a gate that persistently modifies a tracked file leaves no receipt", async () => {
  const { root } = await fixture();
  const captured = capturedOutput();
  const command = nodeCommand(
    `require("node:fs").writeFileSync(${JSON.stringify(join(root, "tracked.txt"))}, "mutated\\n")`,
  );
  assert.equal(await record(root, { ...captured.options, command }), 3);
  const transcriptMessage = captured.messages.find((message) =>
    message.startsWith("gate transcript: "),
  );
  assert.ok(transcriptMessage);
  const transcriptPath = transcriptMessage.slice("gate transcript: ".length);
  assert.equal(existsSync(transcriptPath), true);
  assert.deepEqual(captured.messages, [
    "gate running: frontend-build",
    `  command: ${command}`,
    "gate passed: frontend-build",
    transcriptMessage,
    `gate receipt refused: frontend-build — tree changed during the gate — transcript: ${transcriptPath}`,
  ]);
  assert.equal(
    captured.messages.some((message) => message.includes("gate failed:")),
    false,
  );
  assert.equal(existsSync(join(root, ".gate-receipts", "frontend-build.json")), false);
});

test("8. a gate that modifies a tracked file and restores it before exiting leaves no receipt", async () => {
  const { root } = await fixture();
  const command = nodeCommand(
    `const fs = require("node:fs"); const path = ${JSON.stringify(join(root, "tracked.txt"))}; fs.writeFileSync(path, "mutated\\n"); fs.writeFileSync(path, "initial\\n")`,
  );
  assert.equal(await record(root, { command }), 3);
  assert.equal(existsSync(join(root, ".gate-receipts", "frontend-build.json")), false);
});

test("9. a gate that modifies and restores an ignored file still gets its receipt", async () => {
  const { root } = await fixture();
  const ignoredPath = join(root, "ignored.txt");
  await writeFile(join(root, ".gitignore"), ".gate-receipts/\nartifacts/\nignored.txt\n");
  runGit(root, "add", ".gitignore");
  runGit(
    root,
    "-c",
    "user.name=Gate Receipt Test",
    "-c",
    "user.email=gate-receipt@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "ignore test file",
  );
  await writeFile(ignoredPath, "initial\n");
  const command = nodeCommand(
    `const fs = require("node:fs"); const path = ${JSON.stringify(ignoredPath)}; fs.writeFileSync(path, "mutated\\n"); fs.writeFileSync(path, "initial\\n")`,
  );
  assert.equal(await record(root, { command }), 0);
  assert.equal(existsSync(join(root, ".gate-receipts", "frontend-build.json")), true);
});

// f-20260906-06: the refusal keys on mtime, not bytes, so a writer running beside a gate must
// skip identical content (the Specta binding export does, through `write_if_changed`).
test("10. a gate that rewrites a tracked file with identical bytes leaves no receipt", async () => {
  const { root } = await fixture();
  const command = nodeCommand(
    `require("node:fs").writeFileSync(${JSON.stringify(join(root, "tracked.txt"))}, "initial\\n")`,
  );
  assert.equal(await record(root, { command }), 3);
  assert.equal(existsSync(join(root, ".gate-receipts", "frontend-build.json")), false);
});

test("changed commands, changed platforms, malformed receipts, and unavailable tools are misses", async () => {
  const { root } = await fixture();
  const command = nodeCommand("process.exit(0)");
  assert.equal(await record(root, { command }), 0);
  assert.equal(
    await executeAction({
      action: "check",
      gate: "frontend-build",
      repoRoot: root,
      fingerprintToolchain: fakeToolchain(),
      command: nodeCommand("process.exit(1)"),
      output: silentOutput(),
    }),
    1,
  );

  const receiptPath = join(root, ".gate-receipts", "frontend-build.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.platform = "different-platform";
  await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
  assert.equal(
    await executeAction({
      action: "check",
      gate: "frontend-build",
      repoRoot: root,
      fingerprintToolchain: fakeToolchain(),
      command,
      output: silentOutput(),
    }),
    1,
  );

  assert.equal(
    await executeAction({
      action: "check",
      gate: "frontend-build",
      repoRoot: root,
      fingerprintToolchain: () => undefined,
      command,
      output: silentOutput(),
    }),
    1,
  );

  await writeFile(receiptPath, "not json\n");
  assert.equal(
    await executeAction({
      action: "check",
      gate: "frontend-build",
      repoRoot: root,
      fingerprintToolchain: fakeToolchain(),
      command: nodeCommand("process.exit(0)"),
      output: silentOutput(),
    }),
    1,
  );
});

function capturedOutput() {
  const messages = [];
  const errorMessages = [];
  const stdoutChunks = [];
  const stderrChunks = [];
  const stream = (chunks) =>
    new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
  return {
    messages,
    errorMessages,
    stdoutChunks,
    stderrChunks,
    options: {
      output: {
        log: (message) => messages.push(message),
        error: (message) => {
          messages.push(message);
          errorMessages.push(message);
        },
      },
      forwardedStdout: stream(stdoutChunks),
      forwardedStderr: stream(stderrChunks),
    },
  };
}

function transcriptFromTrailer(messages) {
  const lastLine = messages.at(-1).trim().split("\n").at(-1);
  assert.match(
    lastLine,
    /^gate failed: frontend-build \(exit \d+(?:, signal \w+)?\).* — transcript: \//u,
  );
  const path = lastLine.slice(lastLine.lastIndexOf(" — transcript: ") + " — transcript: ".length);
  assert.equal(existsSync(path), true, lastLine);
  return path;
}

function noisyGate(status) {
  const count = 2200;
  const lines = (prefix) =>
    Array.from(
      { length: count },
      (_, index) => `${prefix}-${String(index).padStart(4, "0")}:${"x".repeat(1014)}\n`,
    );
  const stdout = lines("OUT");
  const stderr = lines("ERR");
  assert.ok(Buffer.byteLength(stdout.join("")) > 1024 ** 2);
  assert.ok(Buffer.byteLength(stderr.join("")) > 1024 ** 2);
  const command = nodeCommand(
    `const fs = require('node:fs'); for (let i = 0; i < ${count}; i++) { const suffix = '-' + String(i).padStart(4, '0') + ':' + 'x'.repeat(1014) + '\\n'; fs.writeSync(1, 'OUT' + suffix); fs.writeSync(2, 'ERR' + suffix); } process.exit(${status});`,
  );
  return { command, stdout, stderr };
}

function assertEveryMarker(transcript, gateOutput) {
  const lines = transcript.split("\n");
  for (const [prefix, expected] of [
    ["OUT-", gateOutput.stdout],
    ["ERR-", gateOutput.stderr],
  ]) {
    assert.deepEqual(
      lines.filter((line) => line.startsWith(prefix)),
      expected.map((line) => line.trimEnd()),
    );
  }
}

test("O2 complete capture: more than 1 MiB on each stream survives with a final transcript trailer", async () => {
  const { root } = await fixture();
  const captured = capturedOutput();
  const gateOutput = noisyGate(23);
  assert.equal(await record(root, { ...captured.options, command: gateOutput.command }), 23);
  const path = transcriptFromTrailer(captured.messages);
  const transcript = await readFile(path, "utf8");
  assertEveryMarker(transcript, gateOutput);
  assert.equal(Buffer.concat(captured.stdoutChunks).toString(), gateOutput.stdout.join(""));
  assert.equal(Buffer.concat(captured.stderrChunks).toString(), gateOutput.stderr.join(""));
  assert.match(
    transcript,
    /^gate: frontend-build\ncommand: .*\ntree: [0-9a-f]+\nstarted: \d{4}-.*Z\n/u,
  );
  assert.match(transcript, /\nexit: 23\nduration: [\d.]+ ms\n$/u);
  const tail = readLogTail(path);
  assert.equal(tail, Buffer.from(transcript).subarray(-LOG_TAIL_BYTES).toString("utf8"));
  const stderr = captured.errorMessages.join("\n");
  const tailStart = stderr.indexOf(tail);
  assert.notEqual(tailStart, -1, "stderr must contain the transcript's last 8 KiB");
  assert.ok(
    tailStart + tail.length < stderr.lastIndexOf(captured.messages.at(-1)),
    "the transcript tail must appear before the final failure trailer",
  );
  assert.equal(existsSync(join(root, ".gate-receipts", "frontend-build.json")), false);
});

test("O2 retention: a green rerun preserves the failing transcript byte for byte in its own run", async () => {
  const { root } = await fixture();
  const failed = capturedOutput();
  assert.equal(
    await record(root, {
      ...failed.options,
      command: nodeCommand("console.log('failure-marker'); process.exit(1)"),
    }),
    1,
  );
  const failedPath = transcriptFromTrailer(failed.messages);
  const original = await readFile(failedPath);
  const green = capturedOutput();
  assert.equal(await record(root, green.options), 0);
  const greenPath = green.messages
    .find((message) => message.startsWith("gate transcript: "))
    .slice("gate transcript: ".length);
  assert.notEqual(dirname(greenPath), dirname(failedPath));
  assert.deepEqual(await readFile(failedPath), original);
  assert.equal(existsSync(greenPath), true);
  assert.deepEqual(
    (await readdir(join(root, "artifacts", "gates"))).sort(),
    [dirname(failedPath).split("/").at(-1), dirname(greenPath).split("/").at(-1)].sort(),
  );
  assert.ok(
    green.messages.indexOf(`gate transcript: ${greenPath}`) <
      green.messages.findIndex((message) => message.startsWith("gate receipt recorded:")),
  );
});

test("O2 refusal before start: an uncreatable run directory returns 2 without executing the gate", async () => {
  const { directory, root } = await fixture();
  await mkdir(join(root, "artifacts"));
  await writeFile(join(root, "artifacts", "gates"), "regular file\n");
  const marker = join(directory, "started.txt");
  const captured = capturedOutput();
  assert.equal(
    await record(root, {
      ...captured.options,
      command: nodeCommand(
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`,
      ),
    }),
    2,
  );
  assert.match(captured.messages.at(-1), /gate transcript unavailable: frontend-build — /u);
  assert.equal(existsSync(marker), false);
});

test("O2 refusal before start: an existing inherited transcript is never overwritten", async () => {
  const { directory, root } = await fixture();
  const logDirectory = makeLogDirectory(root);
  const path = join(logDirectory, transcriptFileName("frontend-build"));
  await writeFile(path, "retained transcript\n");
  const marker = join(directory, "started.txt");
  const captured = capturedOutput();
  assert.equal(
    await record(root, {
      ...captured.options,
      env: { ...process.env, [GATE_LOG_DIRECTORY_ENV]: logDirectory },
      command: nodeCommand(
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`,
      ),
    }),
    2,
  );
  assert.match(captured.messages.at(-1), /gate transcript unavailable: frontend-build — .*EEXIST/u);
  assert.equal(await readFile(path, "utf8"), "retained transcript\n");
  assert.equal(existsSync(marker), false);
});

for (const childStatus of [0, 23]) {
  test(`O2 mid-run write failure: child exit ${childStatus} fails closed and names the write error`, async () => {
    const { root } = await fixture();
    // Start with a reusable receipt: a failed transcript must also remove stale proof.
    assert.equal(await record(root), 0);
    const captured = capturedOutput();
    let childChunks = 0;
    const gateOutput = noisyGate(childStatus);
    const status = await record(root, {
      ...captured.options,
      command: gateOutput.command,
      writeCapturedOutput(fd, chunk) {
        if (Buffer.isBuffer(chunk) && ++childChunks > 1) throw new Error("injected transcript EIO");
        writeSync(fd, chunk);
      },
    });
    assert.equal(status, childStatus || 1);
    assert.ok(childChunks > 1);
    transcriptFromTrailer(captured.messages);
    assert.match(captured.messages.at(-1), /injected transcript EIO.* — transcript: /u);
    assert.equal(existsSync(join(root, ".gate-receipts", "frontend-build.json")), false);
    assert.equal(Buffer.concat(captured.stdoutChunks).toString(), gateOutput.stdout.join(""));
    assert.equal(Buffer.concat(captured.stderrChunks).toString(), gateOutput.stderr.join(""));
  });
}

test(
  "O2 interruption drain: SIGTERM to the runner alone captures the child's shutdown output and returns 143",
  { timeout: 15000 },
  async (t) => {
    const { root } = await fixture();
    const command = `exec ${nodeCommand("const fs = require('node:fs'); process.on('SIGTERM', () => { fs.writeSync(1, 'post-signal-marker\\n'); setTimeout(() => process.exit(0), 25); }); fs.writeSync(1, 'gate-ready\\n'); setInterval(() => {}, 1000); setTimeout(() => process.exit(99), 10000);")}`;
    const receiptModule = new URL("./gate-receipt.mjs", import.meta.url).href;
    const runner = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { executeAction } from ${JSON.stringify(receiptModule)}; process.exitCode = await executeAction({ action: 'run', gate: 'frontend-build', repoRoot: ${JSON.stringify(root)}, command: ${JSON.stringify(command)}, fingerprintToolchain: () => ({ fake: 'one' }) });`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    t.after(() => {
      if (runner.exitCode === null && runner.signalCode === null) runner.kill("SIGKILL");
    });
    const closed = once(runner, "close");
    let stdout = "";
    let stderr = "";
    runner.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    await new Promise((resolve, reject) => {
      runner.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.includes("gate-ready\n")) resolve();
      });
      closed.then(() => reject(new Error(`runner closed before ready: ${stderr}`)), reject);
    });
    assert.equal(runner.kill("SIGTERM"), true);
    assert.deepEqual(await closed, [143, null]);
    const path = transcriptFromTrailer([stderr]);
    const transcript = await readFile(path, "utf8");
    assert.match(transcript, /\npost-signal-marker\n/u);
    assert.match(transcript, /\nexit: 143, signal SIGTERM\nduration: [\d.]+ ms\n$/u);
    assert.match(stdout, /post-signal-marker/u);
    assert.equal(existsSync(join(root, ".gate-receipts", "frontend-build.json")), false);
  },
);

test("O2 inherited directory: a shared run is reused without creating another directory", async () => {
  const { root } = await fixture();
  const logDirectory = makeLogDirectory(root);
  const captured = capturedOutput();
  assert.equal(
    await record(root, {
      ...captured.options,
      env: { ...process.env, [GATE_LOG_DIRECTORY_ENV]: logDirectory },
    }),
    0,
  );
  assert.equal(existsSync(join(logDirectory, transcriptFileName("frontend-build"))), true);
  assert.equal((await readdir(join(root, "artifacts", "gates"))).length, 1);
  assert.equal(
    captured.messages.some((message) => message.includes("Ignoring invalid")),
    false,
  );
});

test("O2 inherited directory: an outside path warns and creates a repository run", async () => {
  const { directory, root } = await fixture();
  const captured = capturedOutput();
  assert.equal(
    await record(root, {
      ...captured.options,
      env: { ...process.env, [GATE_LOG_DIRECTORY_ENV]: directory },
    }),
    0,
  );
  assert.ok(captured.messages.includes(`Ignoring invalid ${GATE_LOG_DIRECTORY_ENV}: ${directory}`));
  const [run] = await readdir(join(root, "artifacts", "gates"));
  assert.equal(
    existsSync(join(root, "artifacts", "gates", run, transcriptFileName("frontend-build"))),
    true,
  );
  assert.equal(existsSync(join(directory, transcriptFileName("frontend-build"))), false);
});

test("O2 gitignore: the real repository ignores receipt transcripts", () => {
  runGit(projectRoot, "check-ignore", "artifacts/gates/x/receipt-frontend-build.log");
});

for (const childStatus of [0, 23]) {
  test(`CR-1 forwarding failure: EPIPE after the first stdout chunk preserves transcript and child exit ${childStatus}`, async () => {
    const { root } = await fixture();
    const captured = capturedOutput();
    const gateOutput = noisyGate(childStatus);
    let writes = 0;
    let errors = 0;
    const brokenStdout = new (class extends Writable {
      emit(event, ...args) {
        if (event === "error") errors += 1;
        return super.emit(event, ...args);
      }
    })({
      write(_chunk, _encoding, callback) {
        writes += 1;
        if (writes === 1) callback();
        else callback(Object.assign(new Error("caller pipe closed"), { code: "EPIPE" }));
      },
    });
    // No test error listener masks a missing production handler for the Writable's EPIPE.
    const status = await record(root, {
      ...captured.options,
      forwardedStdout: brokenStdout,
      command: gateOutput.command,
    });
    assert.equal(status, childStatus);
    assert.equal(writes, 2);
    assert.equal(errors, 1);
    assert.equal(brokenStdout.listenerCount("error"), 0);
    const path = childStatus
      ? transcriptFromTrailer(captured.messages)
      : captured.messages
          .find((message) => message.startsWith("gate transcript: "))
          .slice("gate transcript: ".length);
    assertEveryMarker(await readFile(path, "utf8"), gateOutput);
    assert.equal(Buffer.concat(captured.stderrChunks).toString(), gateOutput.stderr.join(""));
    assert.equal(
      existsSync(join(root, ".gate-receipts", "frontend-build.json")),
      childStatus === 0,
    );
  });
}

test("O2 lifecycle: repeated executeAction calls remove signal and forwarding listeners", async () => {
  const { root } = await fixture();
  const captured = capturedOutput();
  const counts = [
    process.listenerCount("SIGINT"),
    process.listenerCount("SIGTERM"),
    captured.options.forwardedStdout.listenerCount("error"),
    captured.options.forwardedStderr.listenerCount("error"),
  ];
  for (const status of [0, 1, 0]) {
    assert.equal(
      await record(root, { ...captured.options, command: nodeCommand(`process.exit(${status})`) }),
      status,
    );
    assert.deepEqual(
      [
        process.listenerCount("SIGINT"),
        process.listenerCount("SIGTERM"),
        captured.options.forwardedStdout.listenerCount("error"),
        captured.options.forwardedStderr.listenerCount("error"),
      ],
      counts,
    );
  }
});

test("O2 check: a cache query creates no transcript directory", async () => {
  const { root } = await fixture();
  assert.equal(
    await executeAction({
      action: "check",
      gate: "frontend-build",
      repoRoot: root,
      fingerprintToolchain: fakeToolchain(),
      output: silentOutput(),
    }),
    1,
  );
  assert.equal(existsSync(join(root, "artifacts")), false);
});
