import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { platform } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/build-safari-appex.sh", import.meta.url));
const entitlements = await readFile(
  new URL("../safari/extension.entitlements", import.meta.url),
  "utf8",
);
const workflow = await readFile(
  new URL("../../.github/workflows/release.yml", import.meta.url),
  "utf8",
);

test(
  "the Safari build refuses outside macOS before it does anything",
  { skip: platform() === "darwin" },
  () => {
    const run = spawnSync("bash", [script, "/nonexistent/output", "1.0.0"], {
      encoding: "utf8",
      env: { ...process.env, APPLE_SIGNING_IDENTITY: "unused" },
    });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /can only be built on macOS with Xcode/);
    assert.equal(run.stdout, "");
  },
);

test("the committed entitlements are the application sandbox and read access to chosen files", () => {
  assert.match(entitlements, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!DOCTYPE plist /);
  const keys = [...entitlements.matchAll(/<key>([^<]+)<\/key>\s*<(true|false)\/>/g)].map(
    ([, key, value]) => [key, value],
  );
  assert.deepEqual(keys, [
    ["com.apple.security.app-sandbox", "true"],
    ["com.apple.security.files.user-selected.read-only", "true"],
  ]);
  assert.equal(entitlements.match(/<key>/g).length, keys.length);
});

// The release job's steps with the keys that decide whether and how a step runs. The workflow
// writes every step as "- name:" at one indentation, with its keys one level deeper.
function releaseSteps() {
  const lines = workflow.split("\n");
  const start = lines.indexOf("  release:");
  assert.notEqual(start, -1);
  const end = lines.findIndex((line, index) => index > start && /^ {2}[a-z][a-z-]*:$/.test(line));
  const steps = [];
  for (const line of lines.slice(start, end === -1 ? undefined : end)) {
    const name = /^ {6}- name: (.+)$/.exec(line);
    if (name) steps.push({ name: name[1] });
    else if (/^ {6}- /.test(line)) assert.fail(`a release step without a name: ${line}`);
    else {
      const key = /^ {8}(if|continue-on-error|timeout-minutes): (.+)$/.exec(line);
      if (key && steps.length > 0) steps.at(-1)[key[1]] = key[2];
    }
  }
  return steps;
}

const build = "Build and embed the Safari extension (macOS only)";
const verify = "Verify the embedded Safari extension (macOS only)";
const observe = "Observe the Safari verdict on the extension (macOS only, informational)";
const staged = "runner.os == 'macOS' && inputs.safari_extension";

// Staging (d-20261122-33): until a rehearsal with the input is green, a tag release must run
// exactly the steps it ran before the Safari steps existed.
test("the Safari steps run only on macOS and only when a dispatch asks for them", () => {
  assert.match(
    workflow,
    / {2}workflow_dispatch:\n {4}inputs:\n(?: {6}#.*\n)* {6}safari_extension:\n {8}description: .+\n {8}type: boolean\n {8}default: false\n/,
  );
  const steps = releaseSteps();
  const safari = steps.filter(({ name }) => name.includes("Safari"));
  assert.deepEqual(
    safari.map(({ name }) => name),
    [build, verify, observe],
  );
  for (const step of safari) assert.equal(step.if, staged, step.name);
  // The input is named by its definition and by these three conditions, nowhere else.
  assert.equal(workflow.match(/safari_extension/g).length, 4);
});

test("only the observation of Safari may fail without failing the leg, and it cannot stall it", () => {
  const steps = releaseSteps();
  const step = (name) => steps.find((candidate) => candidate.name === name);
  assert.equal(step(observe)["continue-on-error"], "true");
  // The step's own limit of a few minutes; the job's two hours are not a step key.
  assert.match(step(observe)["timeout-minutes"] ?? "", /^[1-9]$/);
  for (const { name, ...keys } of steps)
    if (name !== observe) assert.equal(keys["continue-on-error"], undefined, name);
});

test("the Safari steps sit around the build, and every other release step is unchanged", () => {
  const steps = releaseSteps();
  const order = steps.map(({ name }) => name);
  const secrets = "Require the Apple secrets and write the notarization key (macOS only)";
  assert.ok(order.indexOf("Install app dependencies") < order.indexOf(build));
  assert.ok(order.indexOf(secrets) < order.indexOf(build));
  assert.ok(order.indexOf(build) < order.indexOf("Build the app"));
  assert.ok(
    order.indexOf("Verify signature and notarization (macOS only)") < order.indexOf(verify),
  );
  assert.ok(order.indexOf(verify) < order.indexOf(observe));
  assert.deepEqual(
    steps
      .filter(({ name }) => !name.includes("Safari"))
      .map(({ name, if: condition }) => [name, condition ?? null]),
    [
      ["Checkout repository", null],
      ["Install dependencies (ubuntu only)", "matrix.platform == 'ubuntu-24.04'"],
      ["Install Rust toolchain", null],
      ["Install macOS Rust targets", "runner.os == 'macOS'"],
      ["Rust cache", null],
      ["Install pnpm", null],
      ["Sync node version and setup cache", null],
      ["Install app dependencies", null],
      [secrets, "runner.os == 'macOS'"],
      ["Log in to Certum SimplySign (Windows only)", "runner.os == 'Windows'"],
      ["Point the bundler at the Certum certificate (Windows only)", "runner.os == 'Windows'"],
      ["Build the app", null],
      ["Verify signature and notarization (macOS only)", "runner.os == 'macOS'"],
      ["Verify the Authenticode signatures (Windows only)", "runner.os == 'Windows'"],
      ["Verify the game-link scheme registration (macOS only)", "runner.os == 'macOS'"],
      ["Verify the game-link scheme registration (Linux only)", "runner.os == 'Linux'"],
      ["Verify the game-link scheme registration (Windows only)", "runner.os == 'Windows'"],
      [
        "Log out of Certum SimplySign (Windows only)",
        "always() && steps.certum.outcome != 'skipped'",
      ],
    ],
  );
});
