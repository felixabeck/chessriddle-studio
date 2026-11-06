/**
 * The failure matrix for this artefact (push-review-policy.md section 2).
 *
 * The enumeration follows the throw sites and the filesystem/configuration operations in this
 * file, including the operations awaited by runBranchCoverage. Rows below are staged in
 * scripts/coverage-report-tests.mjs against scratch inputs and fake command results, except row
 * 29, which runs the copied entrypoint against a private project root, and the later CLI failures
 * explicitly marked argued. A direct exported-function call is a real caller.
 * recordBranchRejection records the message AND rejected-promise status of its async call;
 * recordBranchThrow records the message AND synchronous-throw status of its helper call.
 *
 *  #  site                         distinguishing message                         observed status
 * --- ---------------------------- ---------------------------------------------- ------------------
 *  1  run / spawn failure           spawn <rustup|cargo|merge> ENOENT               rejected promise
 *  2  run / killed command          <command> died with SIGTERM: <command> <argv>  rejected promise
 *  3  run / nonzero status          <command> exited with status 23                rejected promise
 *     Rows 1-3 each stage tool resolution, Cargo, and profile merge separately.
 *  4  coverageTools / metadata      Cannot determine sysroot and host for          synchronous throw
 *                                  coverage toolchain <pinned toolchain>
 *  5  coverageTools / runner error  pinned toolchain missing                       synchronous throw
 *  6  clearStaleRawProfiles/unlink  EACCES: permission denied, unlink '<profile>'   rejected promise
 *  7  clear / unreadable walk       EACCES: permission denied, scandir '<target>'   rejected promise
 *  8  assert / unreadable walk      EACCES: permission denied, scandir '<target>'   rejected promise
 *  9  clear / descendant readdir    ENOENT: no such file or directory, scandir      rejected promise
 *                                  '<target>/disappeared'
 * 10  assert / descendant readdir   same descendant ENOENT, on the second walk     rejected promise
 * 11  assert / survivor refusal     Rust coverage left stale raw profiles: <path>  rejected promise
 *     Row 11 calls only runBranchCoverage, returns [] then [<absolute path>] from listProfiles,
 *     and proves Cargo never starts. Both walk errors and the removal error also prove that.
 * 12  post-Cargo profile walk       ENOTDIR: not a directory, scandir '<path>'      rejected promise
 * 13  no new profiles               Rust coverage produced no raw profiles         rejected promise
 * 14  dependencies / readdir        ENOENT: ... scandir '<target>/missing-deps'     rejected promise
 * 15  executable / stat             EACCES: ... stat '<deps>/chessriddle_studio-deadbeef'   rejected promise
 * 16  executable selection          Rust coverage test executable was not found    rejected promise
 * 17  configuration / readFile      ENOENT: ... open '<root>/missing-config.json'   rejected promise
 * 18  configuration / JSON.parse    Expected property name ... in JSON ...         rejected promise
 * 19  configuration / exclusion     Cannot read properties ... (sources, some,     rejected promise
 *     filter (eight wrong shapes)   exclude, map, pattern, length), or
 *                                  coverageConfig.sources.some / source.exclude.map
 *                                  is not a function
 * 20  source filesBelow walk        ENOENT: ... scandir '<root>/src-tauri/src'      rejected promise
 * 21  source selection              Rust coverage found no sources to export       rejected promise
 * 22  exportLcovOrDiagnose / crash   llvm-cov segfaulted while exporting these       synchronous throw
 *                                  sources: ... src-tauri/src/db/schema.rs
 * 23  export / spawn error          spawn llvm-cov ENOENT                          synchronous throw
 * 24  export / nonzero status       llvm-cov died with status 23 while exporting    synchronous throw
 *                                  LCOV
 * 25  export / unisolated signal    llvm-cov died with SIGSEGV while exporting LCOV synchronous throw
 * 26  empty export                  Rust branch coverage export was empty          rejected promise
 * 27  output / writeFile            ENOENT: ... open '<root>/absent/lcov.info'      rejected promise
 * 28  missing branch records        Rust coverage export contains no branch data   rejected promise
 * 29  CLI tool-resolution spawn     spawnSync rustup ENOENT                        exit 1
 *     Row 29 copies this entrypoint and its local modules into a private project root, plants one
 *     exclusively-created profile in that root's coverage target, compares the complete profile
 *     path set and planted bytes around the missing-rustup spawn, and cleans up the owned root.
 *
 * CLI spawns past tool resolution are argued, not staged: the copied entrypoint binds its private
 * coverage target and can clear its planted profile before a later CLI failure or start Cargo.
 * Each rejection above, including the new survivor refusal, escapes main's top-level await as
 * Node's uncaught rejection, whose CLI exit is 1. That exit is described from the exported call,
 * not claimed as a second measured spawn.
 * The staged helper calls do not claim to exercise real Cargo/LLVM failures or a second writer
 * that creates a profile after the refusal walk. No lock is added for that existing race.
 */
import { spawnSync } from "node:child_process";
import { readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { excluded, normalisePath } from "./coverage-scope.mjs";
import { isEntrypoint } from "./entrypoint.mjs";
import { filesBelow } from "./files-below.mjs";
import { parseRustHostMetadata } from "./rust-host.mjs";
import { RUST_COVERAGE_TOOLCHAIN } from "./toolchain-versions.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const toolchain = RUST_COVERAGE_TOOLCHAIN;

function attempt(command, argumentsList, options = {}) {
  return spawnSync(command, argumentsList, {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

function run(command, argumentsList, options = {}, runAttempt = attempt) {
  const result = runAttempt(command, argumentsList, options);
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw result.error;
    // A process killed by a signal reports status null, which on its own names
    // neither the signal nor the command that died.
    if (result.signal)
      throw new Error(
        `${command} died with ${result.signal}: ${command} ${argumentsList.join(" ")}`,
      );
    throw new Error(`${command} exited with status ${result.status}`);
  }
  return result.stdout ?? "";
}

export function coverageTools(runCommand = run) {
  const rustc = ["run", toolchain, "rustc"];
  const sysroot = runCommand("rustup", [...rustc, "--print", "sysroot"]).trim();
  const rustcMetadata = runCommand("rustup", [...rustc, "-vV"]);
  const host = parseRustHostMetadata(rustcMetadata);
  if (!sysroot || !host)
    throw new Error(`Cannot determine sysroot and host for coverage toolchain ${toolchain}`);
  const directory = resolve(sysroot, "lib", "rustlib", host, "bin");
  const suffix = host.split("-").includes("windows") ? ".exe" : "";
  return {
    llvmProfdata: resolve(directory, `llvm-profdata${suffix}`),
    llvmCov: resolve(directory, `llvm-cov${suffix}`),
  };
}

export function isCoverageExecutable(name, details, platform = process.platform) {
  const pattern =
    platform === "win32" ? /^chessriddle_studio-[0-9a-f]+\.exe$/ : /^chessriddle_studio-[0-9a-f]+$/;
  return (
    pattern.test(name) && details.isFile() && (platform === "win32" || (details.mode & 0o111) !== 0)
  );
}

/** One argv for both the bulk export and the per-source crash probe. */
export function llvmCovExportArgs(profilePath, executable, sources) {
  return [
    "export",
    "-format=lcov",
    `-instr-profile=${profilePath}`,
    executable,
    "-sources",
    ...sources,
  ];
}

export function probeCrashingSources(runAttempt, llvmCov, profilePath, executable, sources) {
  return sources.filter(
    (source) =>
      runAttempt(llvmCov, llvmCovExportArgs(profilePath, executable, [source])).signal != null,
  );
}

export function formatExportCrashMessage(offenders, toRelativePath) {
  return [
    "llvm-cov segfaulted while exporting these sources:",
    ...offenders.map((source) => `  ${toRelativePath(source)}`),
    "This is the --branch coverage crash in upstream llvm/llvm-project#119558.",
    "Declare them in backend-coverage-areas.json exclude, with a reason.",
  ].join("\n");
}

export function exportLcovOrDiagnose(
  runAttempt,
  llvmCov,
  profilePath,
  executable,
  sources,
  { toRelativePath = (source) => source } = {},
) {
  const exported = runAttempt(llvmCov, llvmCovExportArgs(profilePath, executable, sources));
  if (exported.signal) {
    const offenders = probeCrashingSources(runAttempt, llvmCov, profilePath, executable, sources);
    if (offenders.length > 0) {
      throw new Error(formatExportCrashMessage(offenders, toRelativePath));
    }
  }
  if (exported.status !== 0) {
    if (exported.stderr) process.stderr.write(exported.stderr);
    if (exported.error) throw exported.error;
    throw new Error(
      `${llvmCov} died with ${exported.signal ?? `status ${exported.status}`} while exporting LCOV`,
    );
  }
  return exported.stdout ?? "";
}

const rawProfilesBelow = (directory) => filesBelow(directory, (path) => path.endsWith(".profraw"));

async function staleRawProfiles(directory, listProfiles) {
  try {
    return await listProfiles(directory);
  } catch (error) {
    // A descendant can disappear during the recursive walk. Only the root's own
    // missing-directory error means there is nothing to clear or refuse.
    if (error.code === "ENOENT" && error.path === resolve(directory)) return [];
    throw error;
  }
}

export async function clearStaleRawProfiles(directory, listProfiles = rawProfilesBelow) {
  for (const path of await staleRawProfiles(directory, listProfiles)) await unlink(path);
}

export async function assertNoStaleRawProfiles(directory, listProfiles = rawProfilesBelow) {
  const profiles = await staleRawProfiles(directory, listProfiles);
  if (profiles.length > 0)
    throw new Error(`Rust coverage left stale raw profiles: ${profiles.sort().join(", ")}`);
}

export async function runBranchCoverage({
  projectRoot: root = projectRoot,
  manifestPath = resolve(root, "src-tauri/Cargo.toml"),
  coverageTarget = resolve(root, "src-tauri/target/llvm-cov-target"),
  dependencies = resolve(coverageTarget, "debug/deps"),
  outputPath = resolve(root, "backend-coverage/lcov.info"),
  profilePath = resolve(root, "backend-coverage/src-tauri.profdata"),
  coverageConfigPath = resolve(root, "backend-coverage-areas.json"),
  runAttempt = attempt,
  runCommand = (command, args, options) => run(command, args, options, runAttempt),
  listProfiles = rawProfilesBelow,
} = {}) {
  const { llvmProfdata, llvmCov } = coverageTools(runCommand);
  await clearStaleRawProfiles(coverageTarget, listProfiles);
  await assertNoStaleRawProfiles(coverageTarget, listProfiles);
  runCommand(
    "cargo",
    [
      `+${toolchain}`,
      "llvm-cov",
      "--manifest-path",
      manifestPath,
      "--bin",
      "chessriddle-studio",
      "--locked",
      "--branch",
      "--no-report",
    ],
    { stdio: "inherit" },
  );

  const profiles = await listProfiles(coverageTarget);
  if (profiles.length === 0) throw new Error("Rust coverage produced no raw profiles");
  runCommand(llvmProfdata, ["merge", "-sparse", "-o", profilePath, ...profiles]);

  const executableCandidates = [];
  for (const entry of await readdir(dependencies)) {
    if (!entry.startsWith("chessriddle_studio-")) continue;
    const path = resolve(dependencies, entry);
    const details = await stat(path);
    if (isCoverageExecutable(entry, details))
      executableCandidates.push({ path, modified: details.mtimeMs });
  }
  if (executableCandidates.length === 0)
    throw new Error("Rust coverage test executable was not found");
  executableCandidates.sort((left, right) => right.modified - left.modified);
  const executable = executableCandidates[0].path;

  // Under --branch coverage, llvm-cov segfaults in
  // CoverageMapping::getInstantiationGroups on certain sources, so those have to stay
  // out of the export. Upstream llvm/llvm-project#119558 (open since Dec 2024, still
  // present in LLVM 22.1) is tracking it: it fires only with --branch, and the crashing
  // files there are macro-expanded code (#[async_trait] impls) that carry plenty of
  // coverage records. So do NOT assume the trigger is "a file with no records" — that
  // happens to describe this crate's three, and would not describe a macro-heavy file
  // added later. Measured here: db/schema.rs (a Diesel table! block) crashes any export
  // it takes part in, while engine/mod.rs and infra/mod.rs crash only when exported on
  // their own. All three are declared in backend-coverage-areas.json's exclude list.
  // This is NOT a limit on how many sources one invocation can take: one export over
  // the remaining sources yields byte-identical LCOV to one export per source.
  const coverageConfig = JSON.parse(await readFile(coverageConfigPath, "utf8"));
  const sources = (await filesBelow(resolve(root, "src-tauri/src"), (path) => path.endsWith(".rs")))
    .filter((path) => {
      const relativePath = normalisePath(path, root);
      return !coverageConfig.sources.some((source) => excluded(relativePath, source));
    })
    .sort();
  if (sources.length === 0) throw new Error("Rust coverage found no sources to export");

  // Name the sources that actually crash instead of failing with a bare "exited with
  // status null": re-probing each one costs well under a second and runs only on this
  // path. It reports what crashed, without assuming why.
  const lcov = exportLcovOrDiagnose(runAttempt, llvmCov, profilePath, executable, sources, {
    toRelativePath: (source) => normalisePath(source, root),
  });
  const sourceCount = lcov.match(/^SF:/gm)?.length ?? 0;
  if (sourceCount === 0) throw new Error("Rust branch coverage export was empty");
  await writeFile(outputPath, `${lcov.trimEnd()}\n`);

  const branchRecords = lcov.match(/^BRDA:/gm)?.length ?? 0;
  if (branchRecords === 0) throw new Error("Rust coverage export contains no branch data");
  console.log(`Rust LCOV: ${sourceCount} sources, ${branchRecords} branch records`);
}

async function main() {
  await runBranchCoverage();
}

if (isEntrypoint(import.meta.url)) {
  await main();
}
