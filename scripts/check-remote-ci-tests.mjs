import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkRemoteCi, MUTATION_RUN_LIMIT, REMOTE_RUN_LIMIT } from "./check-remote-ci.mjs";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptsDirectory, "..");
const cliPath = join(scriptsDirectory, "check-remote-ci.mjs");
const upstreamArgs = ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"];
const defaultRepository = "felixabeck/chessriddle-studio";
const defaultRemoteUrl = `https://github.com/${defaultRepository}.git`;

function sha(tag) {
  return String(tag).padStart(40, "0");
}

function listRunsArgs(
  branch,
  { workflow = "Test", limit = REMOTE_RUN_LIMIT, repository = defaultRepository } = {},
) {
  return [
    "run",
    "list",
    "--workflow",
    workflow,
    "--branch",
    branch,
    "--limit",
    String(limit),
    "--json",
    "databaseId,headSha,status,conclusion,createdAt,displayTitle",
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

function runRemoteCiCli({
  runs,
  mutationRuns = [],
  jobsByRun,
  ghFailure = false,
  cliArgs = [],
  revListByRange = {},
}) {
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
    for (const [range, commits] of Object.entries(revListByRange)) {
      gitResponses.set(JSON.stringify(["rev-list", range]), {
        status: 0,
        stdout: commits.map((commit) => `${commit}\n`).join(""),
        stderr: "",
      });
    }
    const ghResponses = new Map([
      [
        JSON.stringify(listRunsArgs("master")),
        ghFailure
          ? { status: 1, stdout: "", stderr: "API rate limit exceeded\n" }
          : { status: 0, stdout: `${JSON.stringify(runs)}\n`, stderr: "" },
      ],
      [
        JSON.stringify(listRunsArgs("master", { workflow: "Mutation", limit: MUTATION_RUN_LIMIT })),
        { status: 0, stdout: `${JSON.stringify(mutationRuns)}\n`, stderr: "" },
      ],
    ]);
    for (const remoteRun of [...runs, ...mutationRuns]) {
      if (!(remoteRun.databaseId in jobsByRun)) continue;
      const args = viewRunArgs(remoteRun.databaseId);
      ghResponses.set(JSON.stringify(args), {
        status: 0,
        stdout: `${JSON.stringify({ jobs: jobsByRun[remoteRun.databaseId] })}\n`,
        stderr: "",
      });
    }

    writeFakeExecutable(binDirectory, "git", gitResponses);
    writeFakeExecutable(binDirectory, "gh", ghResponses);
    return spawnSync(process.execPath, [cliPath, ...cliArgs], {
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

function run(
  databaseId,
  createdAt,
  {
    status = "completed",
    conclusion = "success",
    headSha = sha(databaseId),
    displayTitle = `commit-${databaseId}`,
  } = {},
) {
  return {
    databaseId,
    headSha,
    status,
    conclusion,
    createdAt,
    displayTitle,
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
  runs = [],
  mutationRuns = [],
  jobsByRun = {},
  revListByRange = {},
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
    if (command === "git" && args[0] === "rev-list" && args[1] in revListByRange) {
      return {
        status: 0,
        stdout: revListByRange[args[1]].map((commit) => `${commit}\n`).join(""),
        stderr: "",
      };
    }
    if (command === "gh" && args[0] === "run" && args[1] === "list") {
      const workflowIndex = args.indexOf("--workflow");
      const workflow = workflowIndex >= 0 ? args[workflowIndex + 1] : "Test";
      const payload = workflow === "Mutation" ? mutationRuns : runs;
      return { status: 0, stdout: JSON.stringify(payload), stderr: "" };
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
const oldest = "2026-10-01T10:00:00Z";
const earliest = "2026-10-01T09:00:00Z";

test("exports the bounded scan limits for Test (30) and Mutation (10)", () => {
  assert.equal(REMOTE_RUN_LIMIT, 30);
  assert.equal(MUTATION_RUN_LIMIT, 10);
});

test("passes when every newest completed job result succeeds", () => {
  const { runner } = cannedRunner({
    runs: [run(101, recent)],
    mutationRuns: [run(201, recent)],
    jobsByRun: {
      101: [job("test"), job("rust-windows-test"), job("rust-platform (MSVC)")],
      201: [job("frontend-mutation-packages"), job("frontend-mutation (app)")],
    },
  });

  assert.deepEqual(checkRemoteCi({ runner }), {
    exitCode: 0,
    branch: "master",
    redJobs: [],
    redMutationJobs: [],
    mutationMessage: null,
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
    [{ name: "test", conclusion: "failure", runId: 101, headSha: sha(101) }],
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
  assert.deepEqual(checkRemoteCi({ runner }), {
    exitCode: 0,
    branch: "master",
    redJobs: [],
    redMutationJobs: [],
    mutationMessage: "no frontend sweep result in the newest 10 runs",
  });
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

test("filters the gh query to the upstream branch and both workflows", () => {
  const { runner, calls } = cannedRunner({
    upstream: "origin/release/ci-remote",
    runs: [run(107, recent)],
    jobsByRun: { 107: [job("test")] },
  });

  assert.equal(checkRemoteCi({ runner }).exitCode, 0);
  const listCalls = calls
    .filter(({ command, args }) => command === "gh" && args[0] === "run" && args[1] === "list")
    .map(({ args }) => args);
  assert.deepEqual(listCalls, [
    listRunsArgs("release/ci-remote", { workflow: "Test", limit: REMOTE_RUN_LIMIT }),
    listRunsArgs("release/ci-remote", { workflow: "Mutation", limit: MUTATION_RUN_LIMIT }),
  ]);
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
      runs: [run(113, recent, { status: "in_progress", conclusion: "" }), run(112, older)],
      mutationRuns: [run(213, recent)],
      jobsByRun: {
        113: [job("test", { status: "in_progress", conclusion: "" })],
        112: [job("test")],
        213: [job("frontend-mutation-packages")],
      },
    });
    const result = checkRemoteCi({ runner });
    assert.deepEqual(
      calls.filter(({ command }) => command === "gh").map(({ args }) => args),
      [
        listRunsArgs("release/ci-remote", {
          workflow: "Test",
          limit: REMOTE_RUN_LIMIT,
          repository: "another-owner/another.repo",
        }),
        viewRunArgs(113, "another-owner/another.repo"),
        viewRunArgs(112, "another-owner/another.repo"),
        listRunsArgs("release/ci-remote", {
          workflow: "Mutation",
          limit: MUTATION_RUN_LIMIT,
          repository: "another-owner/another.repo",
        }),
        viewRunArgs(213, "another-owner/another.repo"),
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
    runs: [run(112, recent, { status: "in_progress", conclusion: "" }), run(111, older)],
    mutationRuns: [run(212, recent)],
    jobsByRun: {
      112: [job("test", { status: "in_progress", conclusion: "" })],
      111: [job("test")],
      212: [job("frontend-mutation-packages")],
    },
  });

  try {
    process.env = parentEnvironment;
    assert.equal(checkRemoteCi({ runner }).exitCode, 0);
    const ghCalls = calls.filter(({ command }) => command === "gh");
    assert.deepEqual(
      ghCalls.map(({ args }) => args.slice(0, 4)),
      [
        ["run", "list", "--workflow", "Test"],
        ["run", "view", "112", "--json"],
        ["run", "view", "111", "--json"],
        ["run", "list", "--workflow", "Mutation"],
        ["run", "view", "212", "--json"],
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

test("refuses when an older run needed for active job resolution has unavailable jobs API", () => {
  const { runner } = cannedRunner({
    runs: [run(130, recent, { status: "in_progress", conclusion: "" }), run(129, older)],
    jobsByRun: { 130: [job("test", { status: "in_progress", conclusion: "" })] },
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

test("refuses an empty jobs list for a completed run", () => {
  const { runner } = cannedRunner({
    runs: [run(108, recent)],
    jobsByRun: { 108: [] },
  });
  const result = checkRemoteCi({ runner });
  assert.equal(result.exitCode, 2);
  assert.match(result.error, /empty jobs list/u);
});

test("passes with a newest queued run with no jobs and an older green run", () => {
  const { runner } = cannedRunner({
    runs: [run(133, recent, { status: "queued", conclusion: "" }), run(132, older)],
    jobsByRun: {
      133: [],
      132: [job("test"), job("rust-windows-test")],
    },
  });

  assert.deepEqual(checkRemoteCi({ runner }), {
    exitCode: 0,
    branch: "master",
    redJobs: [],
    redMutationJobs: [],
    mutationMessage: "no frontend sweep result in the newest 10 runs",
  });
});

test("retains an older red job when the newest queued run has no jobs", () => {
  const { runner } = cannedRunner({
    runs: [
      run(135, recent, { status: "queued", conclusion: "" }),
      run(134, older, { conclusion: "failure" }),
    ],
    jobsByRun: {
      135: [],
      134: [job("test", { conclusion: "failure" })],
    },
  });

  const result = checkRemoteCi({ runner });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(
    result.redJobs.map(({ name, conclusion, runId }) => [name, conclusion, runId]),
    [["test", "failure", 134]],
  );
});

test("refuses when the only run is queued with no jobs", () => {
  const { runner } = cannedRunner({
    runs: [run(136, recent, { status: "queued", conclusion: "" })],
    jobsByRun: { 136: [] },
  });

  const result = checkRemoteCi({ runner });
  assert.equal(result.exitCode, 2);
  assert.match(result.error, /No Test workflow jobs were returned/u);
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

// --- Phase 2 required revert-failing tests ---

test("green push views no more runs than needed (lazy call count)", () => {
  const { runner, calls } = cannedRunner({
    runs: [
      run(155, "2026-10-01T15:00:00Z"),
      run(154, "2026-10-01T14:00:00Z"),
      run(153, "2026-10-01T13:00:00Z"),
      run(152, recent),
      run(151, older),
    ],
    mutationRuns: [
      run(255, "2026-10-01T15:00:00Z"),
      run(254, "2026-10-01T14:00:00Z"),
      run(253, "2026-10-01T13:00:00Z"),
    ],
    jobsByRun: {
      155: [job("frontend"), job("rust")],
      255: [job("frontend-mutation-packages"), job("frontend-mutation (app)")],
    },
  });

  const result = checkRemoteCi({ runner });
  assert.equal(result.exitCode, 0);
  const ghCalls = calls.filter(({ command }) => command === "gh");
  const listCalls = ghCalls.filter(({ args }) => args[1] === "list");
  const viewCalls = ghCalls.filter(({ args }) => args[1] === "view");
  assert.equal(listCalls.length, 2);
  assert.deepEqual(
    viewCalls.map(({ args }) => args[2]),
    ["155", "255"],
  );
});

test("two red jobs with different streak starts are both attributed and printed", () => {
  const runs = [
    run(104, "2026-10-01T14:00:00Z", {
      conclusion: "failure",
      displayTitle: "feat: fourth commit",
    }),
    run(103, recent, {
      conclusion: "failure",
      displayTitle: "fix: third commit",
    }),
    run(102, older, {
      conclusion: "failure",
      displayTitle: "feat: second commit",
    }),
    run(101, oldest, {
      conclusion: "success",
      displayTitle: "chore: green base",
    }),
    run(100, earliest, {
      conclusion: "success",
      displayTitle: "chore: older green",
    }),
  ];
  const jobsByRun = {
    104: [job("e2e", { conclusion: "failure" }), job("rust", { conclusion: "failure" })],
    103: [job("e2e", { conclusion: "success" }), job("rust", { conclusion: "failure" })],
    102: [job("e2e", { conclusion: "success" }), job("rust", { conclusion: "success" })],
    101: [job("e2e", { conclusion: "success" }), job("rust", { conclusion: "success" })],
  };

  const { runner, calls } = cannedRunner({ runs, jobsByRun });
  const result = checkRemoteCi({ runner });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(
    result.redJobs.map(({ name, runId, attribution }) => ({
      name,
      runId,
      attribution,
    })),
    [
      {
        name: "e2e",
        runId: 104,
        attribution: {
          status: "attributed",
          firstRunId: 104,
          firstHeadSha: sha(104),
          firstSubject: "feat: fourth commit",
        },
      },
      {
        name: "rust",
        runId: 104,
        attribution: {
          status: "attributed",
          firstRunId: 103,
          firstHeadSha: sha(103),
          firstSubject: "fix: third commit",
        },
      },
    ],
  );
  // Early stop: run 101 and 100 are not needed once both streaks found their last success at 103/102.
  const viewIds = calls
    .filter(({ command, args }) => command === "gh" && args[1] === "view")
    .map(({ args }) => args[2]);
  assert.deepEqual(viewIds, ["104", "103", "102"]);

  const cli = runRemoteCiCli({ runs, jobsByRun });
  assert.equal(cli.status, 1);
  assert.match(
    cli.stderr,
    new RegExp(
      `e2e: failure \\(newest red run 104, head ${sha(104)}; first red run 104, head ${sha(104)}, subject "feat: fourth commit"\\)`,
      "u",
    ),
  );
  assert.match(
    cli.stderr,
    new RegExp(
      `rust: failure \\(newest red run 104, head ${sha(104)}; first red run 103, head ${sha(103)}, subject "fix: third commit"\\)`,
      "u",
    ),
  );
});

test("own red (first red SHA inside --owner range) exits 1", () => {
  const oldSha = sha(1);
  const ownedMidSha = sha(2);
  const newSha = sha(3);
  const laterSha = sha(4);

  const runs = [
    run(404, "2026-10-01T14:00:00Z", {
      headSha: laterSha,
      conclusion: "failure",
      displayTitle: "other session push",
    }),
    run(403, recent, {
      headSha: newSha,
      conclusion: "failure",
      displayTitle: "own records commit",
    }),
    run(402, older, {
      headSha: ownedMidSha,
      conclusion: "failure",
      displayTitle: "own code commit",
    }),
    run(401, oldest, {
      headSha: oldSha,
      conclusion: "success",
      displayTitle: "green upstream",
    }),
  ];
  const jobsByRun = {
    404: [job("rust", { conclusion: "failure" })],
    403: [job("rust", { conclusion: "failure" })],
    402: [job("rust", { conclusion: "failure" })],
    401: [job("rust", { conclusion: "success" })],
  };
  const revListByRange = { [`${oldSha}..${newSha}`]: [newSha, ownedMidSha] };

  const { runner } = cannedRunner({ runs, jobsByRun, revListByRange });
  const result = checkRemoteCi({ runner, owner: `${oldSha}..${newSha}` });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.owner.ownedJobNames, ["rust"]);

  const cli = runRemoteCiCli({
    runs,
    jobsByRun,
    revListByRange,
    cliArgs: ["--owner", `${oldSha}..${newSha}`],
  });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /own rust: failure/u);
});

test("inherited red (first red SHA outside --owner range) exits 0", () => {
  const inheritedSha = sha(10);
  const oldSha = sha(11);
  const newSha = sha(12);

  const runs = [
    run(503, recent, {
      headSha: newSha,
      conclusion: "failure",
      displayTitle: "our push",
    }),
    run(502, older, {
      headSha: oldSha,
      conclusion: "failure",
      displayTitle: "previous upstream",
    }),
    run(501, oldest, {
      headSha: inheritedSha,
      conclusion: "success",
      displayTitle: "old green",
    }),
  ];
  const jobsByRun = {
    503: [job("e2e", { conclusion: "failure" })],
    502: [job("e2e", { conclusion: "failure" })],
    501: [job("e2e", { conclusion: "success" })],
  };
  const revListByRange = { [`${oldSha}..${newSha}`]: [newSha] };

  const { runner } = cannedRunner({ runs, jobsByRun, revListByRange });
  const result = checkRemoteCi({ runner, owner: `${oldSha}..${newSha}` });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.owner.ownedJobNames, []);
  assert.deepEqual(result.owner.inheritedJobNames, ["e2e"]);

  const cli = runRemoteCiCli({
    runs,
    jobsByRun,
    revListByRange,
    cliArgs: ["--owner", `${oldSha}..${newSha}`],
  });
  assert.equal(cli.status, 0);
  assert.match(cli.stdout, /inherited e2e: failure/u);
});

test("in-progress older run makes attribution undetermined (plain exits 1, --owner exits 2)", () => {
  const oldSha = sha(21);
  const newSha = sha(23);
  const runs = [
    run(603, recent, { headSha: newSha, conclusion: "failure" }),
    run(602, older, { headSha: sha(22), status: "in_progress", conclusion: "" }),
    run(601, oldest, { headSha: oldSha, conclusion: "success" }),
  ];
  const jobsByRun = {
    603: [job("rust", { conclusion: "failure" })],
    602: [job("rust", { status: "in_progress", conclusion: "" })],
    601: [job("rust", { conclusion: "success" })],
  };
  const revListByRange = { [`${oldSha}..${newSha}`]: [newSha] };

  const { runner } = cannedRunner({ runs, jobsByRun, revListByRange });
  const plain = checkRemoteCi({ runner });
  assert.equal(plain.exitCode, 1);
  assert.equal(plain.redJobs[0].attribution.status, "undetermined");
  assert.match(plain.redJobs[0].attribution.reason, /602.*in_progress/u);

  const owned = checkRemoteCi({ runner, owner: `${oldSha}..${newSha}` });
  assert.equal(owned.exitCode, 2);
  assert.match(owned.error, /undetermined/u);
});

test("window exhausted without prior success makes attribution undetermined (plain exits 1, --owner exits 2)", () => {
  const oldSha = sha(31);
  const newSha = sha(32);
  const runs = [
    run(702, recent, { headSha: newSha, conclusion: "failure" }),
    run(701, older, { headSha: oldSha, conclusion: "failure" }),
  ];
  const jobsByRun = {
    702: [job("frontend", { conclusion: "failure" })],
    701: [job("frontend", { conclusion: "failure" })],
  };
  const revListByRange = { [`${oldSha}..${newSha}`]: [newSha] };

  const { runner } = cannedRunner({ runs, jobsByRun, revListByRange });
  const plain = checkRemoteCi({ runner });
  assert.equal(plain.exitCode, 1);
  assert.equal(plain.redJobs[0].attribution.status, "undetermined");
  assert.match(plain.redJobs[0].attribution.reason, /no success for frontend/u);

  const owned = checkRemoteCi({ runner, owner: `${oldSha}..${newSha}` });
  assert.equal(owned.exitCode, 2);
  assert.match(owned.error, /undetermined/u);
});

test("older streak gh run view failure leaves plain red with undetermined reason and --owner refused", () => {
  const oldSha = sha(41);
  const newSha = sha(42);
  const runs = [
    run(712, recent, { headSha: newSha, conclusion: "failure" }),
    run(711, older, { headSha: oldSha, conclusion: "success" }),
  ];
  const jobsByRun = {
    712: [job("frontend", { conclusion: "failure" })],
  };
  const revListByRange = { [`${oldSha}..${newSha}`]: [newSha] };
  const { runner } = cannedRunner({
    runs,
    jobsByRun,
    revListByRange,
    overrides: {
      [`gh ${viewRunArgs(711).join(" ")}`]: {
        status: 1,
        stdout: "",
        stderr: "HTTP 502 Bad Gateway",
      },
    },
  });

  const plain = checkRemoteCi({ runner });
  assert.equal(plain.exitCode, 1);
  assert.equal(plain.redJobs[0].attribution.status, "undetermined");
  assert.match(plain.redJobs[0].attribution.reason, /HTTP 502 Bad Gateway/u);

  const owned = checkRemoteCi({ runner, owner: `${oldSha}..${newSha}` });
  assert.equal(owned.exitCode, 2);
  assert.match(owned.error, /HTTP 502 Bad Gateway/u);
});

for (const malformed of [
  "",
  "abc..def",
  `${sha(1)}...${sha(2)}`,
  `${sha(1)}..`,
  `..${sha(2)}`,
  "HEAD~1..HEAD",
  `${"g".repeat(40)}..${sha(2)}`,
]) {
  test(`malformed --owner range ${JSON.stringify(malformed)} exits 2 before querying gh`, () => {
    const { runner, calls } = cannedRunner({ runs: [], jobsByRun: {} });
    const result = checkRemoteCi({ runner, owner: malformed });
    assert.equal(result.exitCode, 2);
    assert.match(result.error, /Invalid --owner range/u);
    assert.equal(
      calls.some(({ command }) => command === "gh"),
      false,
    );
  });
}

test("CLI refuses missing --owner value, duplicate --owner, and unknown arguments with exit 2", () => {
  const oldSha = sha(51);
  const newSha = sha(52);
  const missingVal = runRemoteCiCli({ runs: [], jobsByRun: {}, cliArgs: ["--owner"] });
  assert.equal(missingVal.status, 2);
  assert.match(missingVal.stderr, /--owner requires/u);

  const duplicateEquals = runRemoteCiCli({
    runs: [],
    jobsByRun: {},
    cliArgs: [`--owner=${oldSha}..${newSha}`, `--owner=${oldSha}..${newSha}`],
  });
  assert.equal(duplicateEquals.status, 2);
  assert.match(duplicateEquals.stderr, /--owner may only be specified once/u);

  const duplicateMixed = runRemoteCiCli({
    runs: [],
    jobsByRun: {},
    cliArgs: ["--owner", `${oldSha}..${newSha}`, `--owner=${oldSha}..${newSha}`],
  });
  assert.equal(duplicateMixed.status, 2);
  assert.match(duplicateMixed.stderr, /--owner may only be specified once/u);

  const duplicateSeparate = runRemoteCiCli({
    runs: [],
    jobsByRun: {},
    cliArgs: ["--owner", `${oldSha}..${newSha}`, "--owner", `${oldSha}..${newSha}`],
  });
  assert.equal(duplicateSeparate.status, 2);
  assert.match(duplicateSeparate.stderr, /--owner may only be specified once/u);

  const unknownArg = runRemoteCiCli({ runs: [], jobsByRun: {}, cliArgs: ["--bogus"] });
  assert.equal(unknownArg.status, 2);
  assert.match(unknownArg.stderr, /Unknown argument/u);
});

test("CLI --owner=<old>..<new> equals form works for own red (1) and inherited red (0)", () => {
  const oldSha = sha(53);
  const newSha = sha(54);
  const runs = [
    run(812, recent, { headSha: newSha, conclusion: "failure" }),
    run(811, older, { headSha: oldSha, conclusion: "success" }),
  ];
  const jobsByRun = {
    812: [job("rust", { conclusion: "failure" })],
    811: [job("rust")],
  };
  const revListByRange = { [`${oldSha}..${newSha}`]: [newSha] };

  const ownCli = runRemoteCiCli({
    runs,
    jobsByRun,
    revListByRange,
    cliArgs: [`--owner=${oldSha}..${newSha}`],
  });
  assert.equal(ownCli.status, 1);
  assert.match(ownCli.stderr, /own rust: failure/u);

  const inheritedRuns = [
    run(814, recent, { headSha: newSha, conclusion: "failure" }),
    run(813, older, { headSha: oldSha, conclusion: "failure" }),
    run(810, oldest, { headSha: sha(50), conclusion: "success" }),
  ];
  const inheritedJobs = {
    814: [job("rust", { conclusion: "failure" })],
    813: [job("rust", { conclusion: "failure" })],
    810: [job("rust")],
  };
  const inheritedCli = runRemoteCiCli({
    runs: inheritedRuns,
    jobsByRun: inheritedJobs,
    revListByRange,
    cliArgs: [`--owner=${oldSha}..${newSha}`],
  });
  assert.equal(inheritedCli.status, 0);
  assert.match(inheritedCli.stdout, /inherited rust: failure/u);
});

test("mixed --owner run with one own red and one inherited red prints both labels and exits 1", () => {
  const earlierSha = sha(55);
  const oldSha = sha(56);
  const newSha = sha(57);
  const runs = [
    run(823, recent, { headSha: newSha, conclusion: "failure" }),
    run(822, older, { headSha: oldSha, conclusion: "failure" }),
    run(821, oldest, { headSha: earlierSha, conclusion: "success" }),
  ];
  const jobsByRun = {
    823: [job("e2e", { conclusion: "failure" }), job("rust", { conclusion: "failure" })],
    822: [job("e2e"), job("rust", { conclusion: "failure" })],
    821: [job("e2e"), job("rust")],
  };
  const revListByRange = { [`${oldSha}..${newSha}`]: [newSha] };

  const { runner } = cannedRunner({ runs, jobsByRun, revListByRange });
  const result = checkRemoteCi({ runner, owner: `${oldSha}..${newSha}` });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.owner.ownedJobNames, ["e2e"]);
  assert.deepEqual(result.owner.inheritedJobNames, ["rust"]);

  const cli = runRemoteCiCli({
    runs,
    jobsByRun,
    revListByRange,
    cliArgs: ["--owner", `${oldSha}..${newSha}`],
  });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /^\s+own e2e: failure/mu);
  assert.match(cli.stderr, /^\s+inherited rust: failure/mu);
});

test("equal, inverted, or <new>-omitting --owner range refuses with exit 2", () => {
  const oldSha = sha(58);
  const newSha = sha(59);

  const equal = cannedRunner({
    runs: [run(831, recent, { headSha: newSha })],
    jobsByRun: { 831: [job("rust")] },
    revListByRange: { [`${newSha}..${newSha}`]: [] },
  });
  const resEqual = checkRemoteCi({ runner: equal.runner, owner: `${newSha}..${newSha}` });
  assert.equal(resEqual.exitCode, 2);
  assert.match(resEqual.error, /resolved to no commits/u);

  const inverted = cannedRunner({
    runs: [run(832, recent, { headSha: oldSha })],
    jobsByRun: { 832: [job("rust")] },
    revListByRange: { [`${newSha}..${oldSha}`]: [] },
  });
  const resInverted = checkRemoteCi({ runner: inverted.runner, owner: `${newSha}..${oldSha}` });
  assert.equal(resInverted.exitCode, 2);
  assert.match(resInverted.error, /resolved to no commits/u);

  const missingNew = cannedRunner({
    runs: [run(833, recent, { headSha: newSha })],
    jobsByRun: { 833: [job("rust")] },
    revListByRange: { [`${oldSha}..${newSha}`]: [sha(60)] },
  });
  const resMissingNew = checkRemoteCi({ runner: missingNew.runner, owner: `${oldSha}..${newSha}` });
  assert.equal(resMissingNew.exitCode, 2);
  assert.match(resMissingNew.error, /does not include <new>/u);
});

test("older run lacking red job or with uncompleted job leaves attribution undetermined (plain 1, --owner 2)", () => {
  const oldSha = sha(63);
  const newSha = sha(64);
  const revListByRange = { [`${oldSha}..${newSha}`]: [newSha] };

  const missingJobRuns = [
    run(842, recent, { headSha: newSha, conclusion: "failure" }),
    run(841, older, { headSha: oldSha, conclusion: "success" }),
  ];
  const missingJobByRun = {
    842: [job("e2e", { conclusion: "failure" })],
    841: [job("rust")],
  };
  const missingRunner = cannedRunner({
    runs: missingJobRuns,
    jobsByRun: missingJobByRun,
    revListByRange,
  });
  const missingPlain = checkRemoteCi({ runner: missingRunner.runner });
  assert.equal(missingPlain.exitCode, 1);
  assert.equal(missingPlain.redJobs[0].attribution.status, "undetermined");
  assert.match(missingPlain.redJobs[0].attribution.reason, /e2e missing in older Test run 841/u);
  const missingOwned = checkRemoteCi({
    runner: missingRunner.runner,
    owner: `${oldSha}..${newSha}`,
  });
  assert.equal(missingOwned.exitCode, 2);
  assert.match(missingOwned.error, /undetermined/u);

  const uncompletedJobRuns = [
    run(844, recent, { headSha: newSha, conclusion: "failure" }),
    run(843, older, { headSha: oldSha, conclusion: "success" }),
  ];
  const uncompletedJobByRun = {
    844: [job("e2e", { conclusion: "failure" })],
    843: [job("e2e", { status: "in_progress", conclusion: "" })],
  };
  const uncompletedRunner = cannedRunner({
    runs: uncompletedJobRuns,
    jobsByRun: uncompletedJobByRun,
    revListByRange,
  });
  const uncompletedPlain = checkRemoteCi({ runner: uncompletedRunner.runner });
  assert.equal(uncompletedPlain.exitCode, 1);
  assert.equal(uncompletedPlain.redJobs[0].attribution.status, "undetermined");
  assert.match(
    uncompletedPlain.redJobs[0].attribution.reason,
    /e2e in older Test run 843 is in_progress/u,
  );
  const uncompletedOwned = checkRemoteCi({
    runner: uncompletedRunner.runner,
    owner: `${oldSha}..${newSha}`,
  });
  assert.equal(uncompletedOwned.exitCode, 2);
  assert.match(uncompletedOwned.error, /undetermined/u);
});

test("Mutation: red frontend-mutation-packages alone exits 1 with job listed and null mutationMessage", () => {
  const runs = [run(851, recent)];
  const mutationRuns = [run(861, recent, { conclusion: "failure" })];
  const jobsByRun = {
    851: [job("frontend")],
    861: [
      job("frontend-mutation-packages", { conclusion: "failure" }),
      job("frontend-mutation", { conclusion: "skipped" }),
    ],
  };

  const { runner } = cannedRunner({ runs, mutationRuns, jobsByRun });
  const result = checkRemoteCi({ runner });
  assert.equal(result.exitCode, 1);
  assert.equal(result.mutationMessage, null);
  assert.deepEqual(
    result.redMutationJobs.map(({ name, conclusion, runId }) => [name, conclusion, runId]),
    [["frontend-mutation-packages", "failure", 861]],
  );

  const cli = runRemoteCiCli({ runs, mutationRuns, jobsByRun });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /Mutation\/frontend-mutation-packages: failure \(run 861/u);
  assert.doesNotMatch(cli.stderr, /no frontend sweep result/u);
});

test("<new> run not completed or absent from window exits 2 under --owner", () => {
  const oldSha = sha(51);
  const newSha = sha(52);
  const revListByRange = { [`${oldSha}..${newSha}`]: [newSha] };

  const inProgress = cannedRunner({
    runs: [run(802, recent, { headSha: newSha, status: "in_progress", conclusion: "" })],
    jobsByRun: { 802: [job("test", { status: "in_progress", conclusion: "" })] },
    revListByRange,
  });
  const resInProgress = checkRemoteCi({ runner: inProgress.runner, owner: `${oldSha}..${newSha}` });
  assert.equal(resInProgress.exitCode, 2);
  assert.match(resInProgress.error, /not completed/u);

  const missing = cannedRunner({
    runs: [run(801, recent, { headSha: oldSha })],
    jobsByRun: { 801: [job("test")] },
    revListByRange,
  });
  const resMissing = checkRemoteCi({ runner: missing.runner, owner: `${oldSha}..${newSha}` });
  assert.equal(resMissing.exitCode, 2);
  assert.match(resMissing.error, /not found in the newest 30 runs/u);
});

test("Mutation: newest frontend result red exits 1 in plain form with the job listed", () => {
  const runs = [run(901, recent)];
  const mutationRuns = [run(951, recent, { conclusion: "failure" })];
  const jobsByRun = {
    901: [job("frontend"), job("rust")],
    951: [
      job("frontend-mutation-packages"),
      job("frontend-mutation (workspace-storage)", { conclusion: "failure" }),
      job("frontend-mutation (tree-path)"),
    ],
  };

  const { runner } = cannedRunner({ runs, mutationRuns, jobsByRun });
  const result = checkRemoteCi({ runner });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(
    result.redMutationJobs.map(({ name, conclusion, runId }) => [name, conclusion, runId]),
    [["frontend-mutation (workspace-storage)", "failure", 951]],
  );

  const cli = runRemoteCiCli({ runs, mutationRuns, jobsByRun });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /Mutation\/frontend-mutation \(workspace-storage\): failure \(run 951/u);
});

test("Mutation: Sunday backend-only and cancelled runs skip back to the last frontend result", () => {
  const runs = [run(902, recent)];
  const mutationRuns = [
    run(964, "2026-10-01T15:00:00Z", { status: "in_progress", conclusion: "" }),
    run(963, "2026-10-01T14:00:00Z", { conclusion: "cancelled" }),
    run(962, recent, { conclusion: "success" }), // Sunday backend-only run
    run(961, older, { conclusion: "failure" }), // prior daily frontend sweep
  ];
  const jobsByRun = {
    902: [job("frontend")],
    // Cancelled during the frontend sweep: that package was never swept.
    963: [
      job("frontend-mutation-packages"),
      job("frontend-mutation (tree-path)", { conclusion: "cancelled" }),
    ],
    962: [
      job("packages"),
      job("backend (chess)", { conclusion: "success" }),
      job("frontend-mutation-packages", { conclusion: "skipped" }),
      job("frontend-mutation", { conclusion: "skipped" }),
    ],
    961: [
      job("frontend-mutation-packages"),
      job("frontend-mutation (tree-path)", { conclusion: "failure" }),
      job("packages", { conclusion: "skipped" }),
      job("backend", { conclusion: "skipped" }),
    ],
  };

  const { runner } = cannedRunner({ runs, mutationRuns, jobsByRun });
  const redResult = checkRemoteCi({ runner });
  assert.equal(redResult.exitCode, 1);
  assert.deepEqual(
    redResult.redMutationJobs.map(({ name, runId }) => [name, runId]),
    [["frontend-mutation (tree-path)", 961]],
  );

  // When the earlier daily frontend sweep succeeded, skipping cancelled + Sunday runs exits 0.
  const greenRunner = cannedRunner({
    runs,
    mutationRuns,
    jobsByRun: {
      ...jobsByRun,
      961: [job("frontend-mutation-packages"), job("frontend-mutation (tree-path)")],
    },
  });
  const greenResult = checkRemoteCi({ runner: greenRunner.runner });
  assert.equal(greenResult.exitCode, 0);
  assert.equal(greenResult.redMutationJobs.length, 0);
});

test("Mutation: a run cancelled only by a backend timeout counts its finished frontend sweep", () => {
  const runs = [run(905, recent)];
  const mutationRuns = [
    run(981, recent, { conclusion: "cancelled" }),
    run(980, older, { conclusion: "failure" }),
  ];
  const jobsByRun = {
    905: [job("frontend")],
    981: [
      job("frontend-mutation-packages"),
      job("frontend-mutation (tree-path)"),
      job("frontend-mutation (workspace-storage)"),
      job("packages"),
      job("backend (lexer)"),
      job("backend (pgn-parser)", { conclusion: "cancelled" }),
    ],
    980: [
      job("frontend-mutation-packages"),
      job("frontend-mutation (tree-path)", { conclusion: "failure" }),
    ],
  };

  const green = checkRemoteCi({ runner: cannedRunner({ runs, mutationRuns, jobsByRun }).runner });
  assert.equal(green.exitCode, 0);
  assert.equal(green.redMutationJobs.length, 0);

  // A red package in that run is still reported from it.
  const red = checkRemoteCi({
    runner: cannedRunner({
      runs,
      mutationRuns,
      jobsByRun: {
        ...jobsByRun,
        981: [
          ...jobsByRun[981].filter(({ name }) => name !== "frontend-mutation (workspace-storage)"),
          job("frontend-mutation (workspace-storage)", { conclusion: "failure" }),
        ],
      },
    }).runner,
  });
  assert.equal(red.exitCode, 1);
  assert.deepEqual(
    red.redMutationJobs.map(({ name, runId }) => [name, runId]),
    [["frontend-mutation (workspace-storage)", 981]],
  );
});

test("Mutation: a cancelled run without jobs, an unswept package list or an unfinished sweep job is skipped", () => {
  const runs = [run(906, recent)];
  const olderRed = {
    990: [
      job("frontend-mutation-packages"),
      job("frontend-mutation (tree-path)", { conclusion: "failure" }),
    ],
  };
  const cases = {
    "cancelled before any job": [],
    "cancelled after the package list only": [
      job("frontend-mutation-packages"),
      job("frontend-mutation", { conclusion: "skipped" }),
    ],
    "completed with an unfinished sweep job": [
      job("frontend-mutation-packages"),
      job("frontend-mutation (tree-path)", { status: "in_progress", conclusion: "" }),
    ],
  };
  for (const [label, jobs] of Object.entries(cases)) {
    const conclusion = label.startsWith("cancelled") ? "cancelled" : "success";
    const mutationRuns = [
      run(991, recent, { conclusion }),
      run(990, older, { conclusion: "failure" }),
    ];
    const result = checkRemoteCi({
      runner: cannedRunner({
        runs,
        mutationRuns,
        jobsByRun: { 906: [job("frontend")], 991: jobs, ...olderRed },
      }).runner,
    });
    assert.equal(result.exitCode, 1, label);
    assert.deepEqual(
      result.redMutationJobs.map(({ name, runId }) => [name, runId]),
      [["frontend-mutation (tree-path)", 990]],
      label,
    );
  }
});

test("Mutation: a finished, not cancelled run without jobs still refuses", () => {
  const result = checkRemoteCi({
    runner: cannedRunner({
      runs: [run(907, recent)],
      mutationRuns: [run(992, recent, { conclusion: "success" })],
      jobsByRun: { 907: [job("frontend")], 992: [] },
    }).runner,
  });
  assert.equal(result.exitCode, 2);
  assert.match(result.error, /empty jobs list/u);
});

test("Mutation: no frontend result in 10 runs is reported and exits 0", () => {
  const runs = [run(903, recent)];
  const mutationRuns = [
    run(972, recent, { conclusion: "cancelled" }),
    run(971, older, { conclusion: "success" }),
  ];
  const jobsByRun = {
    903: [job("frontend")],
    972: [job("frontend-mutation-packages", { conclusion: "cancelled" })],
    971: [
      job("packages"),
      job("backend (chess)"),
      job("frontend-mutation-packages", { conclusion: "skipped" }),
      job("frontend-mutation", { conclusion: "skipped" }),
    ],
  };

  const { runner } = cannedRunner({ runs, mutationRuns, jobsByRun });
  const result = checkRemoteCi({ runner });
  assert.equal(result.exitCode, 0);
  assert.equal(result.mutationMessage, "no frontend sweep result in the newest 10 runs");

  const cli = runRemoteCiCli({ runs, mutationRuns, jobsByRun });
  assert.equal(cli.status, 0);
  assert.match(cli.stdout, /no frontend sweep result in the newest 10 runs/u);
});

test("Mutation: query failure refuses with exit 2", () => {
  const runs = [run(904, recent)];
  const jobsByRun = { 904: [job("frontend")] };

  const listFail = cannedRunner({
    runs,
    jobsByRun,
    overrides: {
      [`gh ${listRunsArgs("master", { workflow: "Mutation", limit: MUTATION_RUN_LIMIT }).join(" ")}`]:
        {
          status: 1,
          stdout: "",
          stderr: "Mutation list 503",
        },
    },
  });
  const resListFail = checkRemoteCi({ runner: listFail.runner });
  assert.equal(resListFail.exitCode, 2);
  assert.match(resListFail.error, /Mutation list 503/u);

  const viewFail = cannedRunner({
    runs,
    mutationRuns: [run(981, recent)],
    jobsByRun,
    overrides: {
      [`gh ${viewRunArgs(981).join(" ")}`]: {
        status: 1,
        stdout: "",
        stderr: "Mutation view 502",
      },
    },
  });
  const resViewFail = checkRemoteCi({ runner: viewFail.runner });
  assert.equal(resViewFail.exitCode, 2);
  assert.match(resViewFail.error, /Mutation view 502/u);
});

test("--owner ignores a red Mutation job", () => {
  const oldSha = sha(61);
  const newSha = sha(62);
  const runs = [run(905, recent, { headSha: newSha })];
  const mutationRuns = [run(991, recent, { conclusion: "failure" })];
  const jobsByRun = {
    905: [job("frontend"), job("rust")],
    991: [
      job("frontend-mutation-packages"),
      job("frontend-mutation (workspace-storage)", { conclusion: "failure" }),
    ],
  };
  const revListByRange = { [`${oldSha}..${newSha}`]: [newSha] };

  const { runner } = cannedRunner({ runs, mutationRuns, jobsByRun, revListByRange });
  const result = checkRemoteCi({ runner, owner: `${oldSha}..${newSha}` });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.redMutationJobs, []);

  const cli = runRemoteCiCli({
    runs,
    mutationRuns,
    jobsByRun,
    revListByRange,
    cliArgs: ["--owner", `${oldSha}..${newSha}`],
  });
  assert.equal(cli.status, 0);
});

test("CLI exits 0 when all newest completed jobs succeed", () => {
  const result = runRemoteCiCli({
    runs: [run(201, recent)],
    mutationRuns: [run(301, recent)],
    jobsByRun: {
      201: [job("test"), job("rust-platform (MSVC)")],
      301: [job("frontend-mutation-packages"), job("frontend-mutation (app)")],
    },
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
