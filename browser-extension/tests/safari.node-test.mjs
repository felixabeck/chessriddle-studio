import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { platform } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/build-safari-appex.sh", import.meta.url));
const classifier = fileURLToPath(
  new URL("../scripts/safari-observation-verdict.sh", import.meta.url),
);
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

// Activation (d-20261122-33): every macOS release carries the extension. The steps were staged
// behind a dispatch input until rehearsal 45101297031 was green.
test("the Safari steps run on every macOS leg, and no dispatch input gates them", () => {
  assert.doesNotMatch(workflow, /safari_extension/);
  assert.match(workflow, /^ {2}workflow_dispatch:\n\n/m);
  const safari = releaseSteps().filter(({ name }) => name.includes("Safari"));
  assert.deepEqual(
    safari.map(({ name }) => name),
    [build, verify, observe],
  );
  for (const step of safari) assert.equal(step.if, "runner.os == 'macOS'", step.name);
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

test("the Safari steps sit around the build", () => {
  const order = releaseSteps().map(({ name }) => name);
  const secrets = "Require the Apple secrets and write the notarization key (macOS only)";
  assert.ok(order.indexOf("Install app dependencies") < order.indexOf(build));
  assert.ok(order.indexOf(secrets) < order.indexOf(build));
  assert.ok(order.indexOf(build) < order.indexOf("Build the app"));
  assert.ok(
    order.indexOf("Verify signature and notarization (macOS only)") < order.indexOf(verify),
  );
  assert.ok(order.indexOf(verify) < order.indexOf(observe));
});

// Lines as Safari wrote them in release rehearsal 45101297031: it opened, and logged nothing
// about web extensions. The first version of the observation read them as "no block observed".
const quietSafari = [
  "2026-11-23 02:52:39.414 Df Safari[33247:169e9] [com.apple.sharekit:Framework] Discover extensions with attributes <private>",
  '    NSExtensionPointName = "com.apple.services";',
  "2026-11-23 02:52:39.414 Df Safari[33247:166fb] [com.apple.sharekit:Framework] Completed querying extensions: <private>",
  "2026-11-23 02:52:39.790 Df Safari[33247:165ea] [com.apple.WebKit:Sandbox] Successfully created a sandbox extension for '<private>'",
];
const verdict = (lines) => {
  const run = spawnSync("bash", [classifier], { encoding: "utf8", input: `${lines.join("\n")}\n` });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trimEnd().split("\n");
};

test("the release classifies Safari's log with the tested script", () => {
  assert.match(
    workflow,
    /report=\$\(printf '%s\\n' "\$lines" \| bash browser-extension\/scripts\/safari-observation-verdict\.sh\)/,
  );
});

test("a Safari that logs nothing about web extensions is an unavailable observation", () => {
  assert.deepEqual(verdict(quietSafari), [
    "observation unavailable: Safari logged nothing about web extensions",
  ]);
  assert.deepEqual(verdict([]), [
    "observation unavailable: Safari logged nothing about web extensions",
  ]);
});

// The two symptoms from Apple developer forum thread 667859, with the identifier masked the way
// the runner's log masks it.
for (const symptom of [
  "Df Safari[37188:1a2b] [Extensions] Blocking extension with identifier: <private>",
  "Df Safari[37188:1a2b] [Extensions] Computing the code signing dictionary failed for extension with identifier <private>",
])
  test(`a block counts without naming the extension: ${symptom.slice(35, 75)}`, () => {
    const output = verdict([...quietSafari, symptom]);
    assert.deepEqual(output, [symptom, "BLOCK OBSERVED"]);
  });

test("lines about web extensions without a block are no block observed", () => {
  const seen = "Df Safari[37188:1a2b] [WebExtensions] Loaded web extension <private>";
  assert.deepEqual(verdict([...quietSafari, seen]), [seen, "no block observed"]);
  const named = "Df Safari[1:2] Found extension com.chessriddle.studio.Extension";
  assert.deepEqual(verdict([named]), [named, "no block observed"]);
});
