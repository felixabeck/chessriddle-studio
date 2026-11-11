import { spawnSync } from "node:child_process";
import { isEntrypoint } from "./entrypoint.mjs";

// Five recent runs bound API work while giving each job a short history for a completed result.
// A job with no completed result in that window refuses the check instead of passing.
export const REMOTE_RUN_LIMIT = 5;

const RUN_FIELDS = "databaseId,headSha,status,conclusion,createdAt";
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is missing or is not a non-empty string`);
  }
  return value;
}

function displayCommand(command, args) {
  return [command, ...args].map((part) => JSON.stringify(part)).join(" ");
}

function runChecked(runner, command, args, cwd) {
  const label = displayCommand(command, args);
  const env = { ...process.env };
  if (command === "gh") {
    // gh honours CLICOLOR_FORCE even with NO_COLOR set. Keep JSON output uncoloured.
    delete env.CLICOLOR_FORCE;
    delete env.FORCE_COLOR;
    delete env.GH_FORCE_TTY;
    env.NO_COLOR = "1";
  }
  let result;
  try {
    result = runner(command, args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(`${label} could not run: ${error.message}`);
  }

  if (!isRecord(result)) throw new Error(`${label} returned no process result`);
  if (result.error) throw new Error(`${label} could not run: ${result.error.message}`);
  if (result.status !== 0) {
    const status = Number.isInteger(result.status)
      ? `exit ${result.status}`
      : result.signal
        ? `terminated by ${result.signal}`
        : "no exit status";
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    throw new Error(`${label} failed (${status})${stderr ? `: ${stderr}` : ""}`);
  }
  if (typeof result.stdout !== "string") {
    throw new Error(`${label} returned no text output`);
  }
  return result.stdout;
}

function parseJson(output, label) {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

function upstreamTarget(runner, cwd) {
  const output = runChecked(
    runner,
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    cwd,
  );
  const upstream = output.trim();
  const separator = upstream.indexOf("/");
  if (separator <= 0 || separator === upstream.length - 1 || upstream.includes("\n")) {
    throw new Error(`git rev-parse returned an invalid upstream ref: ${JSON.stringify(upstream)}`);
  }
  const remote = upstream.slice(0, separator);
  const url = runChecked(runner, "git", ["remote", "get-url", remote], cwd).trim();
  return { branch: upstream.slice(separator + 1), repository: githubRepository(url) };
}

function githubRepository(url) {
  const match =
    /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)$/u.exec(url) ??
    /^git@([^:]+):([^/]+)\/([^/]+)$/u.exec(url);
  if (!match) throw new Error("Upstream remote URL must be a GitHub HTTPS or SCP-style SSH URL");
  const [, host, owner, repositoryPath] = match;
  if (host.toLowerCase() !== "github.com") {
    throw new Error("Upstream remote URL has an unsupported host, expected github.com");
  }
  const repository = repositoryPath.replace(/\.git$/u, "");
  if (
    !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/iu.test(owner) ||
    !/^[a-z\d_.-]+$/iu.test(repository) ||
    repository === "." ||
    repository === ".."
  ) {
    throw new Error("Upstream remote URL has an invalid GitHub owner/repository identity");
  }
  return `${owner}/${repository}`;
}

function validateRun(value, index) {
  const label = `gh run list item ${index + 1}`;
  if (!isRecord(value)) throw new Error(`${label} is not an object`);
  if (!Number.isSafeInteger(value.databaseId) || value.databaseId <= 0) {
    throw new Error(`${label} has an invalid databaseId`);
  }
  requiredString(value.headSha, `${label}.headSha`);
  const status = requiredString(value.status, `${label}.status`);
  if (value.conclusion !== null && typeof value.conclusion !== "string") {
    throw new Error(`${label}.conclusion is neither a string nor null`);
  }
  if (status === "completed") {
    requiredString(value.conclusion, `${label}.conclusion`);
  } else if (value.conclusion !== null && value.conclusion !== "") {
    throw new Error(`${label} has a conclusion before completion`);
  }
  const createdAt = requiredString(value.createdAt, `${label}.createdAt`);
  const createdTime = Date.parse(createdAt);
  if (!Number.isFinite(createdTime)) throw new Error(`${label}.createdAt is not a date`);
  return { ...value, createdTime, originalIndex: index };
}

function validateJob(value, runId, index) {
  const label = `gh run view ${runId} job ${index + 1}`;
  if (!isRecord(value)) throw new Error(`${label} is not an object`);
  const name = requiredString(value.name, `${label}.name`);
  const status = requiredString(value.status, `${label}.status`);
  if (value.conclusion !== null && typeof value.conclusion !== "string") {
    throw new Error(`${label}.conclusion is neither a string nor null`);
  }
  if (status === "completed") {
    requiredString(value.conclusion, `${label}.conclusion`);
  } else if (value.conclusion !== null && value.conclusion !== "") {
    throw new Error(`${label} has a conclusion before completion`);
  }
  const url = requiredString(value.url, `${label}.url`);
  // gh's JSON exporter uses an empty string for an unfinished job's conclusion.
  return { name, status, conclusion: value.conclusion || null, url };
}

function runsForBranch(runner, cwd, branch, repository) {
  const output = runChecked(
    runner,
    "gh",
    [
      "run",
      "list",
      "--workflow",
      "Test",
      "--branch",
      branch,
      "--limit",
      String(REMOTE_RUN_LIMIT),
      "--json",
      RUN_FIELDS,
      "--repo",
      repository,
    ],
    cwd,
  );
  const payload = parseJson(output, "gh run list");
  if (!Array.isArray(payload)) throw new Error("gh run list returned a non-array payload");
  if (payload.length === 0)
    throw new Error(`gh run list returned no Test runs for upstream branch ${branch}`);
  return payload.map(validateRun).sort((left, right) => {
    const byCreatedAt = right.createdTime - left.createdTime;
    return byCreatedAt || left.originalIndex - right.originalIndex;
  });
}

function jobsForRun(runner, cwd, run, repository) {
  const args = ["run", "view", String(run.databaseId), "--json", "jobs", "--repo", repository];
  const output = runChecked(runner, "gh", args, cwd);
  const payload = parseJson(output, `gh run view ${run.databaseId}`);
  if (!isRecord(payload) || !Array.isArray(payload.jobs)) {
    throw new Error(`gh run view ${run.databaseId} returned no jobs array`);
  }
  if (payload.jobs.length === 0) {
    // GitHub may not have scheduled jobs for an unfinished run yet.
    if (run.status !== "completed") return [];
    throw new Error(`gh run view ${run.databaseId} returned an empty jobs list`);
  }
  return payload.jobs.map((job, index) => validateJob(job, run.databaseId, index));
}

function inspectRemoteCi({ runner = spawnSync, cwd = process.cwd() } = {}) {
  const { branch, repository } = upstreamTarget(runner, cwd);
  const runs = runsForBranch(runner, cwd, branch, repository);
  const jobsByName = new Map();
  const activeNames = new Set();
  let completedGenerationSeen = false;

  for (const run of runs) {
    for (const job of jobsForRun(runner, cwd, run, repository)) {
      // The latest completed workflow defines the generation. Newer unfinished runs can
      // introduce jobs, while names exclusive to older completed generations are retired.
      if (!completedGenerationSeen) activeNames.add(job.name);
      if (job.status === "completed" && !jobsByName.has(job.name)) {
        jobsByName.set(job.name, { ...job, runId: run.databaseId, headSha: run.headSha });
      }
    }
    if (run.status === "completed") completedGenerationSeen = true;
  }

  if (activeNames.size === 0) throw new Error("No Test workflow jobs were returned");
  if (![...activeNames].some((name) => jobsByName.has(name)))
    throw new Error("No completed Test workflow jobs were returned in the recent-run window");
  const missing = [...activeNames].filter((name) => !jobsByName.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Jobs have no completed result in the recent-run window: ${missing.join(", ")}`,
    );
  }

  // This workflow has no job-level conditional skips. A skipped or neutral job is therefore
  // treated as red, along with every other completed conclusion except success.
  const redJobs = [...activeNames]
    .map((name) => ({ name, ...jobsByName.get(name) }))
    .filter((job) => job.conclusion !== "success");
  return { branch, redJobs };
}

export function checkRemoteCi(options = {}) {
  try {
    const result = inspectRemoteCi(options);
    return result.redJobs.length > 0 ? { exitCode: 1, ...result } : { exitCode: 0, ...result };
  } catch (error) {
    return { exitCode: 2, error: error instanceof Error ? error.message : String(error) };
  }
}

function main() {
  const result = checkRemoteCi();
  if (result.exitCode === 0) {
    console.log(
      `Remote CI check: OK (all newest completed Test jobs succeeded on ${result.branch})`,
    );
  } else if (result.exitCode === 1) {
    console.error(`Remote CI check: RED (upstream branch ${result.branch})`);
    for (const job of result.redJobs) {
      console.error(
        `  ${job.name}: ${job.conclusion} (run ${job.runId}, head ${job.headSha}) ${job.url}`,
      );
    }
  } else {
    console.error(`Remote CI check: REFUSED: ${result.error}`);
  }
  process.exitCode = result.exitCode;
}

if (isEntrypoint(import.meta.url)) main();
