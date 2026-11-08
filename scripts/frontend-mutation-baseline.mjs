import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ARTIFACT_PREFIX = "frontend-mutation-baseline-";
const RELEASE_BRANCH = "master";
const DAY_MS = 24 * 60 * 60 * 1000;
// One slow GitHub call must not hold the gate: a timeout only costs the package its reuse.
const COMMAND_TIMEOUT_MS = 60_000;
// The artifact listing is a few kilobytes per entry; this only bounds a surprising response.
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** The window CI's restore keys allow: a sweep from today or yesterday, by UTC date. */
export function isRecentSweep(createdAt, now) {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return false;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return created >= today - DAY_MS && created < today + DAY_MS;
}

async function githubRepository(run) {
  const remote = await run("git", ["remote", "get-url", "origin"]);
  const match = remote.match(
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?$/u,
  );
  if (!match) throw new Error("origin is not a GitHub repository");
  return match[1];
}

function assertIncrementalReport(path) {
  const report = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof report?.schemaVersion !== "string" ||
    typeof report.files !== "object" ||
    !report.files
  )
    throw new Error("downloaded results are not a Stryker report");
}

async function downloadPackage(repository, packageId, directory, now, run) {
  const name = `${ARTIFACT_PREFIX}${packageId}`;
  const { artifacts } = JSON.parse(
    await run("gh", ["api", `repos/${repository}/actions/artifacts?name=${name}&per_page=30`]),
  );
  const artifact = artifacts
    .filter(
      (candidate) =>
        !candidate.expired &&
        candidate.workflow_run?.head_branch === RELEASE_BRANCH &&
        isRecentSweep(candidate.created_at, now),
    )
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))[0];
  if (!artifact) throw new Error("no successful sweep from today or yesterday");
  const runId = String(artifact.workflow_run.id);
  const path = join(directory, `${packageId}.json`);
  try {
    await run("gh", ["run", "download", runId, "-R", repository, "-n", name, "-D", directory]);
    assertIncrementalReport(path);
  } catch (error) {
    // Stryker fails on a partial file instead of falling back, so nothing unproven may stay.
    rmSync(path, { force: true });
    throw error;
  }
  return runId;
}

function runProcess(command, args, options) {
  return new Promise((resolve) => {
    execFile(command, args, options, (error, stdout) =>
      resolve(error ? { error } : { status: 0, stdout }),
    );
  });
}

/**
 * Download each package's last successful daily sweep into a fresh directory. A package
 * without usable results simply has no file there, which makes Stryker test it in full,
 * so no failure here can narrow or fail the gate. The caller removes the directory: Stryker
 * rewrites these files, and results from one push must never seed another.
 */
export async function fetchDailySweepResults(
  packageIds,
  { now = new Date(), runCommand = runProcess, log = console.log, signal } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "frontend-mutation-baseline-"));
  const run = async (command, args) => {
    const result = await runCommand(command, args, {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_RESPONSE_BYTES,
      signal,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
    return result.stdout.trim();
  };
  let repository;
  let repositoryError;
  try {
    repository = await githubRepository(run);
  } catch (error) {
    repositoryError = error;
  }
  for (const packageId of packageIds) {
    try {
      if (repositoryError) throw repositoryError;
      const runId = await downloadPackage(repository, packageId, directory, now, run);
      log(`Frontend mutation: ${packageId} reuses daily sweep run ${runId}`);
    } catch (error) {
      log(`Frontend mutation: ${packageId} runs in full (${error.message})`);
    }
  }
  return directory;
}
