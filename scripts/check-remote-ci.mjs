import { spawnSync } from "node:child_process";
import { isEntrypoint } from "./entrypoint.mjs";

// Bounded windows for the branch's newest runs per workflow: Test carries streak history for
// red attribution; Mutation matches policy §8's 10-run window for non-push workflows.
export const REMOTE_RUN_LIMIT = 30;
export const MUTATION_RUN_LIMIT = 10;

const RUN_FIELDS = "databaseId,headSha,status,conclusion,createdAt,displayTitle";
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/iu;
const OWNER_RANGE_PATTERN = /^([0-9a-f]{40})\.\.([0-9a-f]{40})$/iu;
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

function parseOwnerRange(owner) {
  if (typeof owner !== "string") {
    throw new Error("--owner range must be a string of the form <40-hex>..<40-hex>");
  }
  const match = OWNER_RANGE_PATTERN.exec(owner);
  if (!match) {
    throw new Error(`Invalid --owner range ${JSON.stringify(owner)}: expected <40-hex>..<40-hex>`);
  }
  return { oldSha: match[1].toLowerCase(), newSha: match[2].toLowerCase() };
}

function resolveOwnedShas(runner, cwd, oldSha, newSha) {
  const output = runChecked(runner, "git", ["rev-list", `${oldSha}..${newSha}`], cwd);
  const shas = new Set();
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!FULL_SHA_PATTERN.test(line)) {
      throw new Error(`git rev-list returned an invalid SHA: ${JSON.stringify(line)}`);
    }
    shas.add(line.toLowerCase());
  }
  if (shas.size === 0) {
    throw new Error(
      `--owner range ${oldSha}..${newSha} resolved to no commits (equal or inverted range)`,
    );
  }
  if (!shas.has(newSha)) {
    throw new Error(`--owner range ${oldSha}..${newSha} does not include <new> (${newSha})`);
  }
  return shas;
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
  if (
    value.displayTitle !== undefined &&
    value.displayTitle !== null &&
    typeof value.displayTitle !== "string"
  ) {
    throw new Error(`${label}.displayTitle is not a string`);
  }
  const createdAt = requiredString(value.createdAt, `${label}.createdAt`);
  const createdTime = Date.parse(createdAt);
  if (!Number.isFinite(createdTime)) throw new Error(`${label}.createdAt is not a date`);
  const displayTitle = typeof value.displayTitle === "string" ? value.displayTitle.trim() : "";
  return { ...value, displayTitle, createdTime, originalIndex: index };
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

function runsForBranch(
  runner,
  cwd,
  branch,
  repository,
  workflow,
  limit,
  { allowEmpty = false } = {},
) {
  const output = runChecked(
    runner,
    "gh",
    [
      "run",
      "list",
      "--workflow",
      workflow,
      "--branch",
      branch,
      "--limit",
      String(limit),
      "--json",
      RUN_FIELDS,
      "--repo",
      repository,
    ],
    cwd,
  );
  const payload = parseJson(output, "gh run list");
  if (!Array.isArray(payload)) throw new Error("gh run list returned a non-array payload");
  if (payload.length === 0) {
    if (allowEmpty) return [];
    throw new Error(`gh run list returned no ${workflow} runs for upstream branch ${branch}`);
  }
  return payload.map(validateRun).sort((left, right) => {
    const byCreatedAt = right.createdTime - left.createdTime;
    return byCreatedAt || left.originalIndex - right.originalIndex;
  });
}

function jobsForRun(runner, cwd, run, repository, { allowEmptyCompleted = false } = {}) {
  const args = ["run", "view", String(run.databaseId), "--json", "jobs", "--repo", repository];
  const output = runChecked(runner, "gh", args, cwd);
  const payload = parseJson(output, `gh run view ${run.databaseId}`);
  if (!isRecord(payload) || !Array.isArray(payload.jobs)) {
    throw new Error(`gh run view ${run.databaseId} returned no jobs array`);
  }
  if (payload.jobs.length === 0) {
    // GitHub may not have scheduled jobs for an unfinished run yet.
    if (run.status !== "completed" || allowEmptyCompleted) return [];
    throw new Error(`gh run view ${run.databaseId} returned an empty jobs list`);
  }
  return payload.jobs.map((job, index) => validateJob(job, run.databaseId, index));
}

function resolveRedStreaks(runs, redEntries, getRunJobs) {
  if (redEntries.length === 0) return [];

  const states = redEntries.map((entry) => ({
    job: entry,
    newestRunIndex: entry.runIndex,
    currentFirst: {
      runId: entry.runId,
      headSha: entry.headSha,
      displayTitle: entry.displayTitle,
    },
    resolved: false,
    attribution: null,
  }));

  const minStartIndex = Math.min(...states.map((state) => state.newestRunIndex));
  for (let index = minStartIndex + 1; index < runs.length; index += 1) {
    if (states.every((state) => state.resolved)) break;
    const activePending = states.filter((state) => !state.resolved && state.newestRunIndex < index);
    if (activePending.length === 0) continue;

    const olderRun = runs[index];
    if (olderRun.status !== "completed") {
      for (const state of activePending) {
        state.resolved = true;
        state.attribution = {
          status: "undetermined",
          reason: `older Test run ${olderRun.databaseId} is ${olderRun.status}`,
        };
      }
      continue;
    }

    let olderJobs;
    try {
      olderJobs = getRunJobs(olderRun);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      for (const state of activePending) {
        state.resolved = true;
        state.attribution = { status: "undetermined", reason };
      }
      continue;
    }

    const olderJobsByName = new Map(olderJobs.map((job) => [job.name, job]));
    for (const state of activePending) {
      const olderJob = olderJobsByName.get(state.job.name);
      if (!olderJob) {
        state.resolved = true;
        state.attribution = {
          status: "undetermined",
          reason: `job ${state.job.name} missing in older Test run ${olderRun.databaseId}`,
        };
      } else if (olderJob.status !== "completed") {
        state.resolved = true;
        state.attribution = {
          status: "undetermined",
          reason: `job ${state.job.name} in older Test run ${olderRun.databaseId} is ${olderJob.status}`,
        };
      } else if (olderJob.conclusion === "success") {
        state.resolved = true;
        state.attribution = {
          status: "attributed",
          firstRunId: state.currentFirst.runId,
          firstHeadSha: state.currentFirst.headSha,
          firstSubject: state.currentFirst.displayTitle,
        };
      } else {
        state.currentFirst = {
          runId: olderRun.databaseId,
          headSha: olderRun.headSha,
          displayTitle: olderRun.displayTitle,
        };
      }
    }
  }

  for (const state of states) {
    if (!state.resolved) {
      state.resolved = true;
      state.attribution = {
        status: "undetermined",
        reason: `no success for ${state.job.name} in the newest ${runs.length} runs`,
      };
    }
  }

  return states.map(({ job, attribution }) => ({
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    url: job.url,
    runId: job.runId,
    headSha: job.headSha,
    displayTitle: job.displayTitle,
    attribution,
  }));
}

function isFrontendMutationJob(name) {
  return (
    name === "frontend-mutation-packages" ||
    name === "frontend-mutation" ||
    name.startsWith("frontend-mutation (")
  );
}

function inspectMutationSweep(runner, cwd, branch, repository) {
  const runs = runsForBranch(runner, cwd, branch, repository, "Mutation", MUTATION_RUN_LIMIT, {
    allowEmpty: true,
  });

  for (const run of runs) {
    if (run.status !== "completed") continue;
    // A run cancelled before GitHub scheduled any job has none and carries no result.
    const frontendJobs = jobsForRun(runner, cwd, run, repository, {
      allowEmptyCompleted: run.conclusion === "cancelled",
    }).filter((job) => isFrontendMutationJob(job.name));
    // A cancelled or unfinished frontend job leaves its package unswept, so the run says nothing
    // about the sweep. A run cancelled only by a backend job's timeout still carries a full
    // frontend result.
    if (frontendJobs.some((job) => job.status !== "completed" || job.conclusion === "cancelled")) {
      continue;
    }
    const substantiveFrontendJobs = frontendJobs.filter((job) => job.conclusion !== "skipped");
    if (substantiveFrontendJobs.length === 0) continue;
    // The package list alone sweeps nothing: green only when a sweep job ran.
    const sweptOrListFailed = substantiveFrontendJobs.some(
      (job) => job.name !== "frontend-mutation-packages" || job.conclusion !== "success",
    );
    if (!sweptOrListFailed) continue;
    const redMutationJobs = substantiveFrontendJobs
      .filter((job) => job.conclusion !== "success")
      .map((job) => ({
        ...job,
        runId: run.databaseId,
        headSha: run.headSha,
        displayTitle: run.displayTitle,
      }));
    return { redMutationJobs, mutationMessage: null };
  }

  return {
    redMutationJobs: [],
    mutationMessage: `no frontend sweep result in the newest ${MUTATION_RUN_LIMIT} runs`,
  };
}

function inspectRemoteCi({ runner = spawnSync, cwd = process.cwd(), owner } = {}) {
  const ownerRange = owner !== undefined ? parseOwnerRange(owner) : null;
  const { branch, repository } = upstreamTarget(runner, cwd);
  const ownedShas = ownerRange
    ? resolveOwnedShas(runner, cwd, ownerRange.oldSha, ownerRange.newSha)
    : null;

  const runs = runsForBranch(runner, cwd, branch, repository, "Test", REMOTE_RUN_LIMIT);
  if (ownerRange) {
    const newRun = runs.find((run) => run.headSha.toLowerCase() === ownerRange.newSha);
    if (!newRun) {
      throw new Error(
        `Test run for ${ownerRange.newSha} was not found in the newest ${REMOTE_RUN_LIMIT} runs`,
      );
    }
    if (newRun.status !== "completed") {
      throw new Error(
        `Test run ${newRun.databaseId} for ${ownerRange.newSha} is ${newRun.status}, not completed`,
      );
    }
  }

  const jobsCache = new Map();
  const getRunJobs = (run) => {
    if (!jobsCache.has(run.databaseId)) {
      jobsCache.set(run.databaseId, jobsForRun(runner, cwd, run, repository));
    }
    return jobsCache.get(run.databaseId);
  };

  const jobsByName = new Map();
  const activeNames = new Set();
  let completedGenerationSeen = false;

  for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
    const run = runs[runIndex];
    for (const job of getRunJobs(run)) {
      // The latest completed workflow defines the generation. Newer unfinished runs can
      // introduce jobs, while names exclusive to older completed generations are retired.
      if (!completedGenerationSeen) activeNames.add(job.name);
      if (job.status === "completed" && !jobsByName.has(job.name)) {
        jobsByName.set(job.name, {
          ...job,
          runId: run.databaseId,
          headSha: run.headSha,
          displayTitle: run.displayTitle,
          runIndex,
        });
      }
    }
    if (run.status === "completed") completedGenerationSeen = true;
    if (
      completedGenerationSeen &&
      activeNames.size > 0 &&
      [...activeNames].every((name) => jobsByName.has(name))
    ) {
      break;
    }
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
  const redEntries = [...activeNames]
    .map((name) => ({ name, ...jobsByName.get(name) }))
    .filter((job) => job.conclusion !== "success");
  const redJobs = resolveRedStreaks(runs, redEntries, getRunJobs);

  if (ownerRange) {
    const undetermined = redJobs.filter((job) => job.attribution.status !== "attributed");
    if (undetermined.length > 0) {
      const details = undetermined
        .map((job) => `${job.name} (${job.attribution.reason})`)
        .join("; ");
      throw new Error(`Red Test job attribution is undetermined: ${details}`);
    }
    const ownedJobNames = [];
    const inheritedJobNames = [];
    for (const job of redJobs) {
      if (ownedShas.has(job.attribution.firstHeadSha.toLowerCase())) {
        ownedJobNames.push(job.name);
      } else {
        inheritedJobNames.push(job.name);
      }
    }
    return {
      branch,
      redJobs,
      redMutationJobs: [],
      mutationMessage: null,
      owner: {
        oldSha: ownerRange.oldSha,
        newSha: ownerRange.newSha,
        ownedJobNames,
        inheritedJobNames,
      },
    };
  }

  const mutation = inspectMutationSweep(runner, cwd, branch, repository);
  return {
    branch,
    redJobs,
    redMutationJobs: mutation.redMutationJobs,
    mutationMessage: mutation.mutationMessage,
  };
}

export function checkRemoteCi(options = {}) {
  try {
    const result = inspectRemoteCi(options);
    const hasRed = result.owner
      ? result.owner.ownedJobNames.length > 0
      : result.redJobs.length > 0 || result.redMutationJobs.length > 0;
    return { exitCode: hasRed ? 1 : 0, ...result };
  } catch (error) {
    return { exitCode: 2, error: error instanceof Error ? error.message : String(error) };
  }
}

function parseArgs(argv) {
  let owner;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--owner") {
      if (index + 1 >= argv.length) {
        throw new Error("--owner requires <old>..<new>");
      }
      if (owner !== undefined) {
        throw new Error("--owner may only be specified once");
      }
      owner = argv[++index];
    } else if (argument.startsWith("--owner=")) {
      if (owner !== undefined) {
        throw new Error("--owner may only be specified once");
      }
      owner = argument.slice("--owner=".length);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { owner };
}

function formatRedTestJob(job) {
  const attribution =
    job.attribution.status === "attributed"
      ? `first red run ${job.attribution.firstRunId}, head ${job.attribution.firstHeadSha}, subject ${JSON.stringify(job.attribution.firstSubject)}`
      : `first red: undetermined: ${job.attribution.reason}`;
  return `${job.name}: ${job.conclusion} (newest red run ${job.runId}, head ${job.headSha}; ${attribution}) ${job.url}`;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(
      `Remote CI check: REFUSED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
    return;
  }

  const result = checkRemoteCi(args.owner !== undefined ? { owner: args.owner } : {});
  if (result.exitCode === 2) {
    console.error(`Remote CI check: REFUSED: ${result.error}`);
  } else if (result.owner) {
    const { oldSha, newSha, ownedJobNames } = result.owner;
    if (result.exitCode === 0) {
      if (result.redJobs.length === 0) {
        console.log(
          `Remote CI check: OK (all newest completed Test jobs succeeded on ${result.branch}; owner range ${oldSha}..${newSha})`,
        );
      } else {
        console.log(
          `Remote CI check: OK (inherited red only; none attributed to ${oldSha}..${newSha} on ${result.branch})`,
        );
        for (const job of result.redJobs) {
          console.log(`  inherited ${formatRedTestJob(job)}`);
        }
      }
    } else {
      const ownedSet = new Set(ownedJobNames);
      console.error(`Remote CI check: RED (own red in ${oldSha}..${newSha} on ${result.branch})`);
      for (const job of result.redJobs) {
        const tag = ownedSet.has(job.name) ? "own" : "inherited";
        console.error(`  ${tag} ${formatRedTestJob(job)}`);
      }
    }
  } else if (result.exitCode === 0) {
    console.log(
      `Remote CI check: OK (all newest completed Test jobs succeeded on ${result.branch})`,
    );
    if (result.mutationMessage) {
      console.log(`Mutation: ${result.mutationMessage}`);
    }
  } else {
    console.error(`Remote CI check: RED (upstream branch ${result.branch})`);
    for (const job of result.redJobs) {
      console.error(`  ${formatRedTestJob(job)}`);
    }
    for (const job of result.redMutationJobs) {
      console.error(
        `  Mutation/${job.name}: ${job.conclusion} (run ${job.runId}, head ${job.headSha}) ${job.url}`,
      );
    }
    if (result.mutationMessage) {
      console.error(`  Mutation: ${result.mutationMessage}`);
    }
  }
  process.exitCode = result.exitCode;
}

if (isEntrypoint(import.meta.url)) main();
