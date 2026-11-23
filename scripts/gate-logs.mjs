/**
 * Shared gate-log layout and diagnostics. makeLogDirectory(repoRoot, { now, pid, warn }) creates
 * and prunes a run; writeLogChunk(fd, value, write) completes each write;
 * createLogCapture(fd, write) drains chunks while retaining its first error. readLogTail(path)
 * returns at most LOG_TAIL_BYTES as UTF-8 or a one-line read error;
 * formatFailureTrailer(message, path, kind = "log") formats one line.
 * Directory creation errors propagate so callers can refuse to start; pruning only warns.
 */
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";

// Failed command output is bounded so one noisy gate cannot flood the summary.
export const LOG_TAIL_BYTES = 8 * 1024;
// About two days at ~48 runs/day (measured 2026-10-06), <= ~140 MB at the 1.37 MB maximum.
export const MAX_GATE_LOG_RUNS = 100;

const RUN_DIRECTORY_PATTERN = /^\d{8}T\d{9}Z-\d+$/u;
const stderrWarning = (message) => process.stderr.write(`${message}\n`);
const oneLine = (value) => String(value).replaceAll(/[\r\n]+/gu, " ");
const errorMessage = (error) => oneLine(error instanceof Error ? error.message : error);

function logBase(repoRoot) {
  return join(realpathSync(repoRoot), "artifacts", "gates");
}

function pruneRuns(base, currentDirectory, warn) {
  const warning = (path, error) =>
    warn(`Gate log pruning failed: ${oneLine(path)} — ${errorMessage(error)}`);
  let names;
  try {
    names = readdirSync(base);
  } catch (error) {
    warning(base, error);
    return;
  }
  const candidates = [];
  for (const name of names) {
    if (!RUN_DIRECTORY_PATTERN.test(name)) continue;
    const path = join(base, name);
    if (path === currentDirectory) continue;
    try {
      if (lstatSync(path).isDirectory()) candidates.push(name);
    } catch (error) {
      warning(path, error);
    }
  }
  // Always reserve a place for this run, even when the clock moved backwards.
  for (const name of candidates
    .sort()
    .reverse()
    .slice(MAX_GATE_LOG_RUNS - 1)) {
    const path = join(base, name);
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (error) {
      warning(path, error);
    }
  }
}

export function makeLogDirectory(
  repoRoot,
  { now = Date.now, pid = process.pid, warn = stderrWarning } = {},
) {
  const base = logBase(repoRoot);
  mkdirSync(base, { recursive: true });
  if (!lstatSync(base).isDirectory() || realpathSync(base) !== base) {
    throw new Error(`Gate log base is not a real directory: ${base}`);
  }
  const timestamp = `${new Date(now()).toISOString().replaceAll(/[-:.]/gu, "")}-${pid}`;
  const directory = join(base, timestamp);
  mkdirSync(directory, { recursive: false });
  pruneRuns(base, directory, warn);
  return directory;
}

export function writeLogChunk(fd, value, write = writeSync) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  let offset = 0;
  while (offset < buffer.length) {
    const written = write(fd, buffer, offset, buffer.length - offset);
    if (written === 0) throw new Error("log write made no progress");
    offset += written;
  }
}

export function createLogCapture(fd, write = writeLogChunk) {
  let error;
  return {
    capture(chunk) {
      try {
        write(fd, chunk);
      } catch (writeError) {
        error ??= writeError;
      }
    },
    get error() {
      return error;
    },
  };
}

export function readLogTail(path) {
  let fd;
  let tail;
  let failure;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, LOG_TAIL_BYTES));
    const bytesRead = readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    tail = buffer.subarray(0, bytesRead).toString("utf8");
  } catch (error) {
    failure = error;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch (error) {
        failure ??= error;
      }
    }
  }
  return failure ? `Unable to read log tail: ${errorMessage(failure)}` : tail;
}

export function formatFailureTrailer(message, path, kind = "log") {
  return `${oneLine(message)} — ${oneLine(kind)}: ${oneLine(resolve(path))}`;
}
