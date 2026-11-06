import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkRemoteCi, REMOTE_RUN_LIMIT } from "./check-remote-ci.mjs";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptsDirectory, "..");
const cliPath = join(scriptsDirectory, "check-remote-ci.mjs");
const upstreamArgs = ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"];
const defaultRepository = "felixabeck/chessriddle-studio";
const defaultRemoteUrl = `https://github.com/${defaultRepository}.git`;

function listRunsArgs(branch, repository = defaultRepository) {
  return [
    "run",
    "list",
    "--workflow",
    "Test",
    "--branch",
    branch,
    "--limit",
    String(REMOTE_RUN_LIMIT),
    "--json",
    "databaseId,headSha,status,conclusion,createdAt",
    "--repo",
    repository,
  ];
}

function viewRunArgs(runId, repository = defaultRepository) {
  return ["run", "view", String(runId), "--json", "jobs", "--repo", repository];
}

function writeFakeExecutable(binDirectory, command, responses) {
  const path = join(binDirectory, command);
  const source = `#!/usr/bin/env node
const responses = new Map(${JSON.stringify([...responses])});
const args = process.argv.slice(2);
const response = responses.get(JSON.stringify(args));
if (!response) {
  process.stderr.write("unexpected " + ${JSON.stringify(command)} + " invocation: " + JSON.stringify(args) + "\\n");
  process.exitCode = 90;
} else {
  process.stdout.write(response.stdout);
  process.stderr.write(response.stderr);
  process.exitCode = response.status;
}
`;
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function runRemoteCiCli({ runs, jobsByRun, ghFailure = false }) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "check-remote-ci-cli-"));
  try {
    const binDirectory = join(temporaryDirectory, "bin");
    mkdirSync(binDirectory);

    const gitResponses = new Map([
      [JSON.stringify(upstreamArgs), { status: 0, stdout: "origin/master\n", stderr: "" }],
      [
        JSON.stringify(["remote", "get-url", "origin"]),
        { status: 0, stdout: `${defaultRemoteUrl}\n`, stderr: "" },
      ],
    ]);
    const ghResponses = new Map([
      [
        JSON.stringify(listRunsArgs("master")),
        ghFailure
          ? { status: 1, stdout: "", stderr: "API rate limit exceeded\n" }
          : { status: 0, stdout: `${JSON.stringify(runs)}\n`, stderr: "" },
      ],
    ]);
    for (const remoteRun of runs) {
      const args = viewRunArgs(remoteRun.databaseId);
      ghResponses.set(JSON.stringify(args), {
        status: 0,
        stdout: `${JSON.stringify({ jobs: jobsByRun[remoteRun.databaseId] })}\n`,
        stderr: "",
      });
    }

    writeFakeExecutable(binDirectory, "git", gitResponses);
    writeFakeExecutable(binDirectory, "gh", ghResponses);
    return spawnSync(process.execPath, [cliPath], {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: [binDirectory, process.env.PATH].filter(Boolean).join(delimiter),
      },
      timeout: 30_000,
    });
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function run(databaseId, createdAt, { status = "completed", conclusion = "success" } = {}) {
  return {
    databaseId,
    headSha: `sha-${databaseId}`,
    status,
    conclusion,
    createdAt,
  };
}

function job(name, { status = "completed", conclusion = "success" } = {}) {
  return {
    name,
    status,
    conclusion,
    url: `https://github.com/felixabeck/chessriddle-studio/actions/runs/1/jobs/${encodeURIComponent(name)}`,
  };
}

function cannedRunner({
  upstream = "origin/master",
  remoteUrl = defaultRemoteUrl,
  runs,
  jobsByRun,
  overrides = {},
}) {
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    const key = `${command} ${args.join(" ")}`;
    if (key in overrides) return overrides[key];
    if (command === "git" && JSON.stringify(args) === JSON.stringify(upstreamArgs)) {
      return { status: 0, stdout: `${upstream}\n`, stderr: "" };
    }
    if (
      command === "git" &&
      JSON.stringify(args) === JSON.stringify(["remote", "get-url", upstream.split("/")[0]])
    ) {
      return { status: 0, stdout: `${remoteUrl}\n`, stderr: "" };
    }
    if (command === "gh" && args[0] === "run" && args[1] === "list") {
      return { status: 0, stdout: JSON.stringify(runs), stderr: "" };
    }
    if (command === "gh" && args[0] === "run" && args[1] === "view") {
      return {
        status: 0,
        stdout: JSON.stringify({ jobs: jobsByRun[args[2]] }),
        stderr: "",
      };
    }
    return { status: 1, stdout: "", stderr: `unexpected call: ${key}` };
  };
  return { runner, calls };
}

const recent = "2026-10-01T12:00:00Z";
const older = "2026-10-01T11:00:00Z";

test("passes when every newest completed job result succeeds", () => {
  const { runner } = cannedRunner({
    runs: [run(101, recent)],
    jobsByRun: {
      101: [job("test"), job("rust-windows-test"), job("rust-platform (MSVC)")],
    },
  });

  assert.deepEqual(checkRemoteCi({ runner }), {
    exitCode: 0,
    branch: "master",
    redJobs: [],
  });
});

test("uses an older completed result when the newer run is still in progress", () => {
  const { runner } = cannedRunner({
    runs: [
      run(102, recent, { status: "in_progress", conclusion: "" }),
      run(101, older, { conclusion: "failure" }),
    ],
    jobsByRun: {
      102: [job("test", { status: "in_progress", conclusion: "" })],
      101: [job("test", { conclusion: "failure" })],
    },
  });

  const result = checkRemoteCi({ runner });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(
    result.redJobs.map(({ name, conclusion, runId, headSha }) => ({
      name,
      conclusion,
      runId,
      headSha,
    })),
    [{ name: "test", conclusion: "failure", runId: 101, headSha: "sha-101" }],
  );
});

test("refuses on a red job outside the named platform jobs", () => {
  const { runner } = cannedRunner({
    runs: [run(103, recent)],
    jobsByRun: {
      103: [job("rust-windows-test"), job("test", { conclusion: "failure" })],
    },
  });

  const result = checkRemoteCi({ runner });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(
    result.redJobs.map(({ name }) => name),
    ["test"],
  );
  assert.match(result.redJobs[0].url, /actions\/runs\/1\/jobs/u);
});

test("a newer green result supersedes an older red result for the same job", () => {
  const { runner } = cannedRunner({
    runs: [run(104, older), run(105, recent)],
    jobsByRun: {
      104: [job("test", { conclusion: "failure" })],
      105: [job("test")],
    },
  });

  assert.equal(checkRemoteCi({ runner }).exitCode, 0);
});

test("retires cancelled old matrix names after a newer completed green generation", () => {
  const { runner } = cannedRunner({
    runs: [run(120, older, { conclusion: "cancelled" }), run(121, recent)],
    jobsByRun: {
      121: [job("test"), job("rust-platform (macos-26-intel, test)")],
      120: [
        job("test", { conclusion: "cancelled" }),
        job("rust-platform (macos-latest, test)", { conclusion: "cancelled" }),
      ],
    },
  });
  assert.deepEqual(checkRemoteCi({ runner }), { exitCode: 0, branch: "master", redJobs: [] });
});

test("a newer unfinished generation retains current prior red results and adds new jobs", () => {
  const { runner } = cannedRunner({
    runs: [
      run(124, "2026-10-01T13:00:00Z", { status: "in_progress", conclusion: "" }),
      run(123, recent, { conclusion: "failure" }),
      run(122, older, { conclusion: "cancelled" }),
    ],
    jobsByRun: {
      124: [
        job("test", { status: "in_progress", conclusion: "" }),
        job("new-job", { conclusion: "failure" }),
      ],
      123: [
        job("test", { conclusion: "failure" }),
        job("still-current", { conclusion: "failure" }),
      ],
      122: [job("retired-job", { conclusion: "cancelled" })],
    },
  });
  const result = checkRemoteCi({ runner });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(
    result.redJobs.map(({ name, conclusion, runId }) => [name, conclusion, runId]),
    [
      ["test", "failure", 123],
      ["new-job", "failure", 124],
      ["still-current", "failure", 123],
    ],
  );
});

test("refuses a new unfinished job with no completed proof in prior generations", () => {
  const { runner } = cannedRunner({
    runs: [run(126, recent, { status: "in_progress", conclusion: "" }), run(125, older)],
    jobsByRun: {
      126: [job("test"), job("new-job", { status: "queued", conclusion: "" })],
      125: [job("test")],
    },
  });
  const result = checkRemoteCi({ runner });
  assert.equal(result.exitCode, 2);
  assert.match(result.error, /no completed result.*new-job/u);
});

test("uses all unfinished generations when no workflow run has completed", () => {
  const { runner } = cannedRunner({
    runs: [
      run(128, recent, { status: "in_progress", conclusion: "" }),
      run(127, older, { status: "in_progress", conclusion: "" }),
    ],
    jobsByRun: {
      128: [job("test", { status: "in_progress", conclusion: "" })],
      127: [
        job("test", { conclusion: "failure" }),
        job("earlier-unfinished-job", { conclusion: "failure" }),
      ],
    },
  });
  const result = checkRemoteCi({ runner });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(
    result.redJobs.map(({ name, runId }) => [name, runId]),
    [
      ["test", 127],
      ["earlier-unfinished-job", 127],
    ],
  );
});

test("treats skipped and neutral conclusions as red because Test has no designed job skips", () => {
  const { runner } = cannedRunner({
    runs: [run(106, recent)],
    jobsByRun: {
      106: [
        job("skipped-job", { conclusion: "skipped" }),
        job("neutral-job", { conclusion: "neutral" }),
      ],
    },
  });

  const result = checkRemoteCi({ runner });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(
    result.redJobs.map(({ name, conclusion }) => [name, conclusion]),
    [
      ["skipped-job", "skipped"],
      ["neutral-job", "neutral"],
    ],
  );
});

test("filters the gh query to the upstream branch and Test workflow", () => {
  const { runner, calls } = cannedRunner({
    upstream: "origin/release/ci-remote",
    runs: [run(107, recent)],
    jobsByRun: { 107: [job("test")] },
  });

  assert.equal(checkRemoteCi({ runner }).exitCode, 0);
  const listCall = calls.find(
    ({ command, args }) => command === "gh" && args[0] === "run" && args[1] === "list",
  );
  assert.deepEqual(listCall.args, listRunsArgs("release/ci-remote"));
});

for (const remoteUrl of [
  "https://github.com/another-owner/another.repo.git",
  "https://github.com/another-owner/another.repo",
  "git@github.com:another-owner/another.repo.git",
  "git@github.com:another-owner/another.repo",
]) {
  test(`pins every gh call to the upstream repository from ${remoteUrl}`, () => {
    const { runner, calls } = cannedRunner({
      upstream: "fork/release/ci-remote",
      remoteUrl,
      runs: [run(113, recent), run(112, older)],
      jobsByRun: { 113: [job("test")], 112: [job("test")] },
    });
    const result = checkRemoteCi({ runner });
    assert.deepEqual(
      calls.filter(({ command }) => command === "gh").map(({ args }) => args),
      [
        listRunsArgs("release/ci-remote", "another-owner/another.repo"),
        viewRunArgs(113, "another-owner/another.repo"),
        viewRunArgs(112, "another-owner/another.repo"),
      ],
    );
    assert.deepEqual(
      calls.filter(({ command }) => command === "git").map(({ args }) => args),
      [upstreamArgs, ["remote", "get-url", "fork"]],
    );
    assert.equal(result.exitCode, 0);
  });
}

for (const [remoteUrl, error] of [
  ["", /must be a GitHub HTTPS or SCP-style SSH URL/u],
  ["https://github.com/owner", /must be a GitHub HTTPS or SCP-style SSH URL/u],
  ["file:///tmp/repository.git", /must be a GitHub HTTPS or SCP-style SSH URL/u],
  ["https://gitlab.com/owner/repository.git", /unsupported host/u],
  ["git@example.com:owner/repository.git", /unsupported host/u],
  ["https://github.com/owner/repository.git?query", /invalid GitHub owner\/repository/u],
  ["https://github.com/owner/..", /invalid GitHub owner\/repository/u],
  ["https://github.com/owner/.git", /invalid GitHub owner\/repository/u],
  ["https://github.com/owner/repository/extra", /must be a GitHub HTTPS or SCP-style SSH URL/u],
]) {
  test(`refuses invalid upstream remote URL ${JSON.stringify(remoteUrl)} before querying gh`, () => {
    const { runner, calls } = cannedRunner({ remoteUrl });
    const result = checkRemoteCi({ runner });
    assert.equal(result.exitCode, 2);
    assert.match(result.error, error);
    assert.equal(
      calls.some(({ command }) => command === "gh"),
      false,
    );
  });
}

test("refuses a missing upstream remote with the git failure cause", () => {
  const { runner, calls } = cannedRunner({
    upstream: "fork/master",
    overrides: {
      "git remote get-url fork": {
        status: 2,
        stdout: "",
        stderr: "No such remote 'fork'",
      },
    },
  });
  const result = checkRemoteCi({ runner });
  assert.equal(result.exitCode, 2);
  assert.match(result.error, /No such remote 'fork'/u);
  assert.equal(
    calls.some(({ command }) => command === "gh"),
    false,
  );
});

test("disables colour forcing for every gh call while preserving the parent environment", () => {
  const originalEnvironment = process.env;
  const parentEnvironment = {
    ...originalEnvironment,
    CLICOLOR_FORCE: "1",
    FORCE_COLOR: "1",
    GH_FORCE_TTY: "120",
    NO_COLOR: "",
    GH_TOKEN: "regression-test-token",
    GH_REPO: "franciscoBSalgueiro/en-croissant",
  };
  const { runner, calls } = cannedRunner({
    runs: [run(112, recent), run(111, older)],
    jobsByRun: { 112: [job("test")], 111: [job("test")] },
  });

  try {
    process.env = parentEnvironment;
    assert.equal(checkRemoteCi({ runner }).exitCode, 0);
    const ghCalls = calls.filter(({ command }) => command === "gh");
    assert.deepEqual(
      ghCalls.map(({ args }) => args.slice(0, 3)),
      [
        ["run", "list", "--workflow"],
        ["run", "view", "112"],
        ["run", "view", "111"],
      ],
    );
    for (const { options } of ghCalls) {
      assert.ok(options.env, "gh must receive an explicit environment");
      assert.ok(options.env !== parentEnvironment, "gh must receive its own environment");
      for (const name of ["CLICOLOR_FORCE", "FORCE_COLOR", "GH_FORCE_TTY"]) {
        assert.equal(Object.hasOwn(options.env, name), false, `${name} must be absent`);
      }
      assert.equal(options.env.NO_COLOR, "1");
      for (const [name, value] of Object.entries(parentEnvironment)) {
        if (["CLICOLOR_FORCE", "FORCE_COLOR", "GH_FORCE_TTY", "NO_COLOR"].includes(name)) {
          continue;
        }
        // Compare without including inherited credentials in assertion diagnostics.
        assert.ok(options.env[name] === value, `${name} must be preserved`);
      }
    }
    assert.deepEqual(
      ghCalls.map(({ args }) => args.slice(-2)),
      ghCalls.map(() => ["--repo", defaultRepository]),
      "conflicting GH_REPO must not select the repository",
    );
    assert.equal(parentEnvironment.CLICOLOR_FORCE, "1");
    assert.equal(parentEnvironment.FORCE_COLOR, "1");
    assert.equal(parentEnvironment.GH_FORCE_TTY, "120");
    assert.equal(parentEnvironment.NO_COLOR, "");
    assert.equal(parentEnvironment.GH_REPO, "franciscoBSalgueiro/en-croissant");
  } finally {
    process.env = originalEnvironment;
  }
});

test("refuses with the gh failure cause", () => {
  const { runner } = cannedRunner({
    runs: [],
    jobsByRun: {},
    overrides: {
      [`gh ${listRunsArgs("master").join(" ")}`]: {
        status: 1,
        stdout: "",
        stderr: "API rate limit exceeded",
      },
    },
  });

  const result = checkRemoteCi({ runner });
  assert.equal(result.exitCode, 2);
  assert.match(result.error, /API rate limit exceeded/u);
});

test("refuses with the git failure cause", () => {
  const { runner } = cannedRunner({
    runs: [],
    jobsByRun: {},
    overrides: {
      "git rev-parse --abbrev-ref --symbolic-full-name @{u}": {
        status: 128,
        stdout: "",
        stderr: "no upstream configured",
      },
    },
  });

  const result = checkRemoteCi({ runner });
  assert.equal(result.exitCode, 2);
  assert.match(result.error, /no upstream configured/u);
});

test("refuses when an older run's jobs API is unavailable", () => {
  const { runner } = cannedRunner({
    runs: [run(130, recent), run(129, older)],
    jobsByRun: { 130: [job("test")] },
    overrides: {
      [`gh ${viewRunArgs(129).join(" ")}`]: {
        status: 1,
        stdout: "",
        stderr: "HTTP 503 Service Unavailable",
      },
    },
  });
  const result = checkRemoteCi({ runner });
  assert.equal(result.exitCode, 2);
  assert.match(result.error, /HTTP 503 Service Unavailable/u);
});

test("refuses malformed jobs from the API", () => {
  const { runner } = cannedRunner({
    runs: [run(131, recent)],
    overrides: {
      [`gh ${viewRunArgs(131).join(" ")}`]: {
        status: 0,
        stdout: JSON.stringify({ jobs: null }),
        stderr: "",
      },
    },
  });
  const result = checkRemoteCi({ runner });
  assert.equal(result.exitCode, 2);
  assert.match(result.error, /returned no jobs array/u);
});

test("reports when spawnSync terminated the command by signal", () => {
  const { runner } = cannedRunner({
    runs: [],
    jobsByRun: {},
    overrides: {
      "git rev-parse --abbrev-ref --symbolic-full-name @{u}": {
        status: null,
        signal: "SIGTERM",
        stdout: "",
        stderr: "",
      },
    },
  });

  const result = checkRemoteCi({ runner });
  assert.equal(result.exitCode, 2);
  assert.match(result.error, /terminated by SIGTERM/u);
  assert.doesNotMatch(result.error, /no exit status/u);
});

test("refuses an unparsable upstream result", () => {
  const { runner } = cannedRunner({ upstream: "not-an-upstream" });
  const result = checkRemoteCi({ runner });
  assert.equal(result.exitCode, 2);
  assert.match(result.error, /invalid upstream ref/u);
});

test("refuses a malformed gh payload with its cause", () => {
  const { runner } = cannedRunner({
    runs: [],
    jobsByRun: {},
    overrides: {
      [`gh ${listRunsArgs("master").join(" ")}`]: {
        status: 0,
        stdout: "{ malformed",
        stderr: "",
      },
    },
  });

  const result = checkRemoteCi({ runner });
  assert.equal(result.exitCode, 2);
  assert.match(result.error, /invalid JSON/u);
});

test("refuses an empty run list", () => {
  const { runner } = cannedRunner({ runs: [], jobsByRun: {} });
  const result = checkRemoteCi({ runner });
  assert.equal(result.exitCode, 2);
  assert.match(result.error, /no Test runs/u);
});

test("refuses an empty jobs list", () => {
  const { runner } = cannedRunner({
    runs: [run(108, recent)],
    jobsByRun: { 108: [] },
  });
  const result = checkRemoteCi({ runner });
  assert.equal(result.exitCode, 2);
  assert.match(result.error, /empty jobs list/u);
});

test("refuses when a seen job has no completed result in the window", () => {
  const { runner } = cannedRunner({
    runs: [run(109, recent)],
    jobsByRun: {
      109: [job("test"), job("rust-platform", { status: "in_progress", conclusion: "" })],
    },
  });
  const result = checkRemoteCi({ runner });
  assert.equal(result.exitCode, 2);
  assert.match(result.error, /no completed result.*rust-platform/u);
});

test("refuses when no job in the window has a completed result", () => {
  const { runner } = cannedRunner({
    runs: [run(110, recent, { status: "in_progress", conclusion: "" })],
    jobsByRun: {
      110: [job("test", { status: "in_progress", conclusion: "" })],
    },
  });
  const result = checkRemoteCi({ runner });
  assert.equal(result.exitCode, 2);
  assert.match(result.error, /No completed Test workflow jobs/u);
});

test("CLI exits 0 when all newest completed jobs succeed", () => {
  const result = runRemoteCiCli({
    runs: [run(201, recent)],
    jobsByRun: { 201: [job("test"), job("rust-platform (MSVC)")] },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Remote CI check: OK/u);
});

test("CLI exits 1 and names a red job", () => {
  const result = runRemoteCiCli({
    runs: [run(202, recent)],
    jobsByRun: { 202: [job("required-linux-tests", { conclusion: "failure" })] },
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Remote CI check: RED/u);
  assert.match(result.stderr, /required-linux-tests: failure/u);
});

test("CLI exits 2 and prints the gh failure cause", () => {
  const result = runRemoteCiCli({ runs: [], jobsByRun: {}, ghFailure: true });

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /API rate limit exceeded/u);
});
