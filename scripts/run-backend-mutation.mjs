// Runs cargo-mutants over eight packages in an independent snapshot outside the checkout.
// The durable exclusive fence owns a mutation-only cache and records the Linux
// subreaper. Cleanup requires positive descendant-terminal evidence before removing
// the snapshot/fence. The live marker scan also protects interrupted legacy runs.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative, isAbsolute, sep, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { installMultiChildSignalForwarding, superviseChild } from "./child-supervisor.mjs";
import { durableWrite } from "./durable-write.mjs";
import { isEntrypoint } from "./entrypoint.mjs";
import { fsyncDirectory } from "./fsync-directory.mjs";
import { selectMutationPackages } from "./mutation-package-selection.mjs";
import { currentIdentity, identityForPid, identityIsLive } from "./process-identity.mjs";
import { parseRustHostMetadata } from "./rust-host.mjs";

const snapshotPrefix = "chessfable-backend-mutation-";
const containmentScript = fileURLToPath(
  new URL("./mutation-process-containment.py", import.meta.url),
);
export const fencePath = "mutants.out/backend/.mutation-in-progress";
export const mutationCacheRelativePath = "mutants.out/backend/cargo-target";
const mutationMarker = "~ changed by cargo-mutants ~";
const terminationTimeoutMs = 8_000;
// Give each cargo-mutants test at least this many seconds before timing it out.
const minimumTestTimeoutSeconds = 30;
const encodingAddressSpaceLimit = "2147483648";
const suppressMutationCoreEnvironment = "CHESSFABLE_ENCODING_MUTATION_SUPPRESS_CORE";

export const backendMutationPackages = Object.freeze([
  {
    id: "database-encoding",
    file: "src/db/encoding.rs",
    functions:
      "encode_move|decode_move|encode_comment|encode_nag|MainlineMoveBytesIter|try_iter_mainline_move_bytes|decode_game|render_nodes",
    test: "db::encoding::tests",
  },
  {
    id: "database-search",
    file: "src/db/search.rs",
    functions:
      "PositionQuery::matches|MaterialQuery::is_reachable_by|MaterialQuery::can_reach|is_end_reachable|is_material_reachable|is_contained|matches_date|parse_wanted_result",
    test: "db::search::tests",
  },
  {
    id: "engine-protocol",
    file: "src/engine/types.rs",
    functions: "validate_uci_text",
    test: "engine::types::tests",
  },
  {
    id: "download-policy",
    file: "src/fs.rs",
    functions:
      "DownloadOperation::from_id|DownloadOperation::max_size|DownloadOperation::payload_format|DownloadOperation::limits|validate_download_url|is_bearer_origin|validate_archive_path",
    test: "fs::tests",
  },
  {
    id: "game-rules",
    file: "src/game.rs",
    functions:
      "validate_time_controls|GameController::apply_move|GameController::check_game_end|GameController::settle_active_clock|GameController::get_current_times|GameController::end_game|split_epd_position_and_operations|validate_epd_operations|choose_weighted_index|choose_weighted_target|opening_book_ext",
    test: "game::tests",
  },
  {
    id: "path-authority",
    file: "src/infra/path_authority/mod.rs",
    functions:
      "class_is_root|is_write_operation|validate_persisted_shape|PathAuthority::validate_components",
    test: "infra::path_authority::tests",
  },
  { id: "lexer", file: "src/lexer.rs", functions: "Lexer|lex_pgn_sync", test: "lexer::tests" },
  {
    id: "pgn-parser",
    file: "src/pgn.rs",
    functions:
      "is_tag_header|update_brace_comment|read_bounded_line|validate_game_count|scan_games|checked_index|checked_range",
    test: "pgn::tests",
  },
]);

// `--list-packages` must remain side-effect free: the workflow uses it before a
// checkout has installed cargo-mutants or created the output directory.
if (process.argv.includes("--list-packages")) {
  console.log(JSON.stringify(backendMutationPackages.map(({ id }) => id)));
  process.exit(0);
}

function runGit(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

function trackedMutationFiles() {
  const result = runGit(["grep", "-l", "-F", mutationMarker, "--", "src-tauri"]);
  if (result.status === 1) return [];
  if (result.status !== 0) {
    throw new Error(
      `git grep failed while checking for cargo-mutants markers (exit ${result.status}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim().split("\n").filter(Boolean);
}

function shellQuote(path) {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

function recordedOwner() {
  return readFileSync(fencePath, "utf8");
}

function recordField(record, name) {
  return record
    ?.split("\n")
    .find((line) => line.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function recordedIdentity(record) {
  const pid = Number(recordField(record, "pid"));
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const startTime = recordField(record, "pidStartTime");
  return { pid, ...(startTime ? { startTime } : {}) };
}

function validSnapshotPath(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) return false;
  return (
    dirname(path) === resolve(tmpdir()) &&
    basename(path).startsWith(snapshotPrefix) &&
    /^[a-zA-Z0-9]{6}$/u.test(basename(path).slice(snapshotPrefix.length))
  );
}

function printRecovery() {
  let identity;
  let record;
  let identityError;
  try {
    record = recordedOwner();
    identity = recordedIdentity(record);
  } catch (error) {
    identityError = error;
  }
  let markedFiles = [];
  let scanError;
  try {
    markedFiles = trackedMutationFiles();
  } catch (error) {
    scanError = error;
  }

  console.error(`Backend mutation fence exists: ${fencePath}`);
  console.error("Recovery procedure:");
  console.error("1. Confirm no `cargo mutants` process is running, and terminate it if one is.");
  console.error(
    "   Inspect all mutation descendants, including other sessions. Owner death alone does not prove they have stopped.",
  );
  const identityLabel = recordField(record, "snapshot") ? "containment-owner" : "cargo";
  if (identity !== undefined) {
    try {
      console.error(
        `   Recorded ${identityLabel} pid: ${identity.pid}, currently alive: ${identityIsLive(identity) ? "yes" : "no"}.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `   Recorded ${identityLabel} pid: ${identity.pid}, currently alive: unknown (${message}).`,
      );
    }
  } else {
    console.error(
      "   No containment-owner pid was recorded (legacy record or preparation). Inspect the process list by command name.",
    );
    if (identityError) {
      console.error(
        `   Fence owner record is unreadable: ${identityError instanceof Error ? identityError.message : String(identityError)}.`,
      );
    }
  }
  console.error(
    "2. Restore only tracked files that contain the literal `~ changed by cargo-mutants ~` marker.",
  );
  if (scanError) {
    console.error(`   Marker scan failed: ${scanError.message}`);
  } else if (markedFiles.length === 0) {
    console.error("   No tracked src-tauri files currently contain the marker.");
  } else {
    for (const path of markedFiles) console.error(`   ${path}`);
    console.error(`   git checkout -- ${markedFiles.map(shellQuote).join(" ")}`);
  }
  const snapshot = recordField(record, "snapshot");
  if (validSnapshotPath(snapshot)) {
    console.error(
      `3. Remove the recorded snapshot only after confirming all mutation descendants have stopped: rm -rf -- ${shellQuote(snapshot)}`,
    );
  } else {
    console.error("3. Recorded snapshot is unknown/malformed. No snapshot deletion is suggested.");
  }
  console.error(`4. Remove the fence: rm -- ${shellQuote(fencePath)}`);
}

if (process.argv.includes("--check-guard")) {
  if (!existsSync(fencePath)) process.exit(0);
  printRecovery();
  process.exit(1);
}

export function selectBackendMutationPackages(packageId = process.env.BACKEND_MUTATION_PACKAGE) {
  return selectMutationPackages(
    backendMutationPackages,
    packageId ? [packageId] : undefined,
    "BACKEND_MUTATION_PACKAGE",
  );
}

const selectedPackages = selectBackendMutationPackages();

function assertCleanBackend() {
  let result;
  try {
    result = runGit(["status", "--porcelain", "--", "src-tauri"]);
  } catch (error) {
    throw new Error(`Refusing backend mutation: git status failed: ${error.message}`, {
      cause: error,
    });
  }
  if (result.status !== 0) {
    throw new Error(
      `Refusing backend mutation: git status failed with exit ${result.status}: ${result.stderr.trim()}`,
    );
  }
  if (result.stdout !== "") {
    const paths = result.stdout
      .trimEnd()
      .split("\n")
      .map((line) => line.slice(3));
    throw new Error(`Refusing backend mutation: src-tauri is dirty:\n${paths.join("\n")}`);
  }
}

function excludedInput(path) {
  return path
    .split("/")
    .some(
      (part) =>
        [".git", "node_modules", "target", "mutants.out"].includes(part) || part.startsWith(".env"),
    );
}

function regularInput(root, path) {
  const components = path.split("/");
  if (isAbsolute(path) || components.some((part) => part === ".." || part === "." || part === "")) {
    throw new Error(`Unsafe snapshot input path: ${path}`);
  }
  let current = root;
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (index < components.length - 1 && !stat.isDirectory())) {
      throw new Error(
        `Snapshot input ${path} is a symlink or has a non-directory ancestor. Replace it with independent regular files.`,
      );
    }
    if (index === components.length - 1 && !stat.isFile()) {
      throw new Error(`Snapshot input is not a regular file: ${path}`);
    }
  }
  return lstatSync(current);
}

function snapshotManifest(liveRoot) {
  const listed = runGit(["ls-files", "-z"]);
  if (listed.status !== 0) throw new Error(`Snapshot git ls-files failed: ${listed.stderr}`);
  const paths = new Set(listed.stdout.split("\0").filter((path) => path && !excludedInput(path)));
  const dist = join(liveRoot, "dist");
  if (!existsSync(dist) || !existsSync(join(dist, "index.html"))) {
    throw new Error(
      "Backend mutation requires dist/index.html. Run pnpm build-vite before pnpm mutation:backend.",
    );
  }
  const visit = (path) => {
    const stat = lstatSync(join(liveRoot, path));
    if (stat.isSymbolicLink())
      throw new Error(
        `Snapshot input is a symlink: ${path}. Replace it with independent regular files.`,
      );
    if (!stat.isDirectory()) throw new Error(`Snapshot directory is not a directory: ${path}`);
    for (const name of readdirSync(join(liveRoot, path))) {
      const child = `${path}/${name}`;
      if (excludedInput(child)) continue;
      const stat = lstatSync(join(liveRoot, child));
      if (stat.isDirectory()) visit(child);
      else paths.add(child);
    }
  };
  visit("dist");
  return [...paths].sort();
}

function fileHash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function captureSnapshot(liveRoot, snapshot, afterCopy) {
  const manifest = snapshotManifest(liveRoot);
  const captured = new Map();
  for (const path of manifest) {
    const stat = regularInput(liveRoot, path);
    const destination = join(snapshot, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(liveRoot, path), destination);
    chmodSync(destination, stat.mode & 0o777);
    captured.set(path, { hash: fileHash(destination), mode: stat.mode & 0o777 });
  }
  await afterCopy?.({ liveRoot, snapshot });
  if (JSON.stringify(snapshotManifest(liveRoot)) !== JSON.stringify(manifest)) {
    throw new Error(
      "Snapshot input manifest changed during capture. Stop concurrent edits and retry.",
    );
  }
  for (const [path, expected] of captured) {
    const stat = regularInput(liveRoot, path);
    if (
      fileHash(join(liveRoot, path)) !== expected.hash ||
      (stat.mode & 0o777) !== expected.mode ||
      fileHash(join(snapshot, path)) !== expected.hash
    ) {
      throw new Error(
        `Snapshot source changed during capture: ${path}. Stop concurrent edits and retry.`,
      );
    }
  }
}

function prepareCache(liveRoot) {
  const cache = join(liveRoot, mutationCacheRelativePath);
  const liveTarget = join(liveRoot, "src-tauri", "target");
  const resolvedTarget = existsSync(liveTarget) ? realpathSync(liveTarget) : liveTarget;
  const targetIdentity = existsSync(resolvedTarget)
    ? lstatSync(resolvedTarget, { bigint: true })
    : undefined;
  // Every existing ancestor must be a directory, never a symlink redirecting a build.
  let current = sep;
  for (const component of cache.split(sep).filter(Boolean)) {
    current = join(current, component);
    if (existsSync(current)) {
      const stat = lstatSync(current, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(
          `Mutation cache has an unsafe ancestor: ${current}. Remove the alias before retrying.`,
        );
      }
      if (targetIdentity && stat.dev === targetIdentity.dev && stat.ino === targetIdentity.ino) {
        throw new Error(
          `Mutation cache aliases src-tauri/target at ${current}. Remove the alias before retrying.`,
        );
      }
    } else mkdirSync(current);
  }
  const resolvedCache = realpathSync(cache);
  if (
    resolvedCache === resolvedTarget ||
    !relative(resolvedTarget, resolvedCache).startsWith("..")
  ) {
    throw new Error("Mutation cache aliases src-tauri/target. Remove the alias before retrying.");
  }
  return cache;
}

function successfulOutput(command, args, purpose) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) {
    throw new Error(`Backend mutation ${purpose} failed: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.signal) {
    throw new Error(
      `Backend mutation ${purpose} failed: ${command} died with ${result.signal}${
        result.stderr ? `: ${result.stderr.trim()}` : ""
      }`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Backend mutation ${purpose} failed: ${command} exited with status ${result.status}${
        result.stderr ? `: ${result.stderr.trim()}` : ""
      }`,
    );
  }
  return result.stdout ?? "";
}

export function encodingCargoArguments(host) {
  const runnerConfig = JSON.stringify([
    "prlimit",
    `--as=${encodingAddressSpaceLimit}`,
    "--core=0",
    "--",
  ]);
  return ["--target", host, "--config", `target.${host}.runner=${runnerConfig}`];
}

function prepareEncodingContainment() {
  if (process.platform !== "linux") return [];
  const metadata = successfulOutput("rustc", ["-vV"], "host detection");
  const host = parseRustHostMetadata(metadata);
  if (!host) {
    throw new Error("Backend mutation host detection failed: rustc -vV returned no valid host");
  }
  successfulOutput(
    "prlimit",
    [`--as=${encodingAddressSpaceLimit}`, "--core=0", "--", "/bin/true"],
    "prlimit runner setup",
  );
  return encodingCargoArguments(host);
}

function cargoArguments(mutationPackage, containmentCargoArguments, snapshot, liveRoot) {
  const cargoArguments = [
    "mutants",
    "--manifest-path",
    join(snapshot, "src-tauri", "Cargo.toml"),
    "--in-place",
    "--cargo-arg=--locked",
    ...containmentCargoArguments.map((argument) => `--cargo-arg=${argument}`),
    "--baseline=run",
    "--caught",
    "--unviable",
    "--no-config",
    "--file",
    mutationPackage.file,
    "--re",
    mutationPackage.functions,
    "--minimum-test-timeout",
    String(minimumTestTimeoutSeconds),
    "--output",
    join(liveRoot, "mutants.out", "backend", mutationPackage.id),
    "--",
    mutationPackage.test,
  ];
  return cargoArguments;
}

function mutationChildEnvironment(mutationPackage, cache) {
  const environment = { ...process.env, CARGO_TARGET_DIR: cache };
  if (process.platform === "linux" && mutationPackage.id === "database-encoding") {
    environment[suppressMutationCoreEnvironment] = "1";
  } else {
    delete environment[suppressMutationCoreEnvironment];
  }
  return environment;
}

function clearFence() {
  unlinkSync(fencePath);
  fsyncDirectory(dirname(fencePath));
}

function reportRetainedState(label, path) {
  if (path === undefined) {
    console.error(`${label} not created`);
    return;
  }
  try {
    lstatSync(path);
    console.error(`${label} retained: ${path}`);
  } catch (error) {
    console.error(
      error.code === "ENOENT"
        ? `${label} already removed: ${path}`
        : `${label} retention unknown: ${path} (${error.message})`,
    );
  }
}

export async function runBackendMutation({
  recordChild = undefined,
  afterSnapshotCopy = undefined,
  beforeOwnerPublish = undefined,
  afterWrapperExit = undefined,
} = {}) {
  if (existsSync(fencePath)) {
    printRecovery();
    return 1;
  }
  assertCleanBackend();
  const containmentCargoArguments = selectedPackages.some(({ id }) => id === "database-encoding")
    ? prepareEncodingContainment()
    : [];
  successfulOutput(
    "python3",
    [containmentScript, "--check"],
    "Python 3/subreaper capability check (install Python 3 on Linux)",
  );
  const liveRoot = realpathSync(process.cwd());
  const temporaryRelative = relative(liveRoot, realpathSync(tmpdir()));
  if (temporaryRelative !== ".." && !temporaryRelative.startsWith(`..${sep}`)) {
    throw new Error(
      "Backend mutation requires a temporary directory outside the checkout. Set TMPDIR to an external directory and retry.",
    );
  }
  const runnerIdentity = currentIdentity();
  const signalForwarding = installMultiChildSignalForwarding({ label: "backend mutation" });
  let snapshot;
  let cache;
  let ownsFence = false;
  let fenceSetupCompleted = false;
  let ownerRecord;
  let supervisor;
  const terminals = [];
  let exitCode = 0;
  let cleanupFailed = false;
  const started = new Date().toISOString();
  const makeRecord = (identity = undefined) =>
    `started=${started}\nrunnerPid=${runnerIdentity.pid}\nrunnerStartTime=${runnerIdentity.startTime}\nsnapshot=${snapshot}\ncache=${cache}\n` +
    (identity ? `pid=${identity.pid}\npidStartTime=${identity.startTime}\n` : "");
  const publish = (identity = undefined, exclusive = false) => {
    const next = makeRecord(identity);
    if (!exclusive && recordedOwner() !== ownerRecord)
      throw new Error("Backend mutation fence owner changed or is unreadable");
    durableWrite(fencePath, next, {
      exclusive,
      beforePublish: () => beforeOwnerPublish?.({ exclusive, snapshot, identity }),
      onPublished: () => {
        ownsFence = true;
        ownerRecord = next;
      },
    });
  };
  const verifyTerminal = (terminal) => {
    if (!terminal.result || terminal.result.signal || terminal.result.error) {
      throw new Error(
        "Containment owner did not exit normally. Terminal evidence cannot authorize cleanup.",
      );
    }
    const evidence = JSON.parse(readFileSync(terminal.path, "utf8"));
    if (
      evidence["no-unwaited-children"] !== true ||
      evidence.pid !== terminal.identity?.pid ||
      evidence.pidStartTime !== terminal.identity?.startTime ||
      !Number.isInteger(evidence.status) ||
      evidence.status !== terminal.result.code ||
      (evidence.signal !== null &&
        (!Number.isInteger(evidence.signal) || evidence.status !== 128 + evidence.signal))
    ) {
      throw new Error("Containment terminal evidence is missing or malformed");
    }
  };
  const verifyOwnedState = () => {
    // No malformed or foreign metadata can authorize deletion after publication.
    if (recordedOwner() !== ownerRecord || !validSnapshotPath(snapshot)) {
      throw new Error("Backend mutation owner state changed or is unreadable");
    }
    const markedFiles = trackedMutationFiles();
    if (markedFiles.length > 0) {
      throw new Error(
        `Backend mutation left cargo-mutants markers in tracked files:\n${markedFiles.join("\n")}`,
      );
    }
  };
  try {
    cache = prepareCache(liveRoot);
    snapshot = mkdtempSync(join(tmpdir(), snapshotPrefix));
    try {
      publish(undefined, true);
      fenceSetupCompleted = true;
    } catch (error) {
      if (error.code === "EEXIST") {
        printRecovery();
        return 1;
      }
      throw error;
    }
    // Readability is part of preparation, before the first owned child.
    if (recordedOwner() !== ownerRecord)
      throw new Error("Backend mutation fence record is unreadable");
    try {
      await captureSnapshot(liveRoot, snapshot, afterSnapshotCopy);
    } catch (error) {
      throw new Error(
        `Backend mutation snapshot preparation failed: ${error.message}. Restore the required regular inputs and retry after pnpm build-vite.`,
        { cause: error },
      );
    }
    for (const mutationPackage of selectedPackages) {
      if (signalForwarding.requestedSignal) break;
      console.log(
        `\nBackend mutation package: ${mutationPackage.id}\nSnapshot: ${snapshot}\nCargo target: ${cache}`,
      );
      const output = join(liveRoot, "mutants.out", "backend", mutationPackage.id);
      mkdirSync(output, { recursive: true });
      const terminal = { path: join(output, "terminal.json") };
      // Retain the latest proof per package, never an unbounded series of receipts.
      if (existsSync(terminal.path)) unlinkSync(terminal.path);
      terminals.push(terminal);
      const child = spawn(
        "python3",
        [
          containmentScript,
          terminal.path,
          "--",
          "cargo",
          ...cargoArguments(
            mutationPackage,
            mutationPackage.id === "database-encoding" ? containmentCargoArguments : [],
            snapshot,
            liveRoot,
          ),
        ],
        {
          // Whole-tree gates must never see the source being mutated.
          cwd: snapshot,
          stdio: "inherit",
          env: mutationChildEnvironment(mutationPackage, cache),
        },
      );
      supervisor = superviseChild(child, { terminationTimeoutMs });
      signalForwarding.attach(supervisor, mutationPackage.id);
      try {
        terminal.identity = child.pid === undefined ? undefined : identityForPid(child.pid);
        if (!terminal.identity) throw new Error("Cannot record containment owner identity");
        publish(terminal.identity);
        recordChild?.(child);
      } catch (error) {
        terminal.result = await supervisor.terminate();
        throw error;
      }
      terminal.result = await supervisor.done;
      supervisor = undefined;
      await afterWrapperExit?.(terminal);
      verifyTerminal(terminal);
      if (signalForwarding.requestedSignal) break;
      const result = terminal.result;
      if (result.code === 0) continue;
      const missedPath = join(output, "mutants.out", "missed.txt");
      const missed = existsSync(missedPath) ? readFileSync(missedPath, "utf8").trim() : "";
      // cargo-mutants reports timeouts with exit 3. A timeout is a killed mutant,
      // but any actual survivor remains a hard failure.
      if (result.code === 3 && missed === "") continue;
      exitCode = result.code ?? 1;
      break;
    }
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    try {
      if (supervisor) {
        const terminal = terminals.at(-1);
        terminal.result = await supervisor.terminate();
      }
      await signalForwarding.termination;
      for (const terminal of terminals) verifyTerminal(terminal);
      if (ownsFence && fenceSetupCompleted) verifyOwnedState();
      if (snapshot) rmSync(snapshot, { recursive: true });
      if (ownsFence) clearFence();
    } catch (error) {
      cleanupFailed = true;
      console.error(
        `Backend mutation finaliser could not verify the tree or terminal state: ${error.message}`,
      );
      reportRetainedState("Fence", fencePath);
      reportRetainedState("Snapshot", snapshot);
      exitCode = 1;
    } finally {
      signalForwarding.uninstall();
    }
  }
  if (cleanupFailed) return 1;
  if (signalForwarding.requestedSignal) {
    return signalForwarding.requestedSignal === "SIGINT" ? 130 : 143;
  }
  return exitCode;
}

if (isEntrypoint(import.meta.url)) {
  try {
    process.exitCode = await runBackendMutation();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
