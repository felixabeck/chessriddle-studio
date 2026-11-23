import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import {
  LOG_TAIL_BYTES,
  MAX_GATE_LOG_RUNS,
  createLogCapture,
  formatFailureTrailer,
  makeLogDirectory,
  readLogTail,
  writeLogChunk,
} from "./gate-logs.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "gate-logs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = join(root, "artifacts", "gates");
  mkdirSync(base, { recursive: true });
  return { root, base };
}

const creationOptions = { now: () => Date.UTC(2026, 9, 7, 12, 34, 56, 789), pid: 123 };

test("writeLogChunk completes strings and buffers across short writes", () => {
  for (const value of ["complete ä log line\n", Buffer.from("complete ä log line\n")]) {
    const chunks = [];
    writeLogChunk(123, value, (fd, buffer, offset, length) => {
      assert.equal(fd, 123);
      assert.equal(length, buffer.length - offset);
      const written = Math.min(3, length);
      chunks.push(Buffer.from(buffer.subarray(offset, offset + written)));
      return written;
    });
    assert.deepEqual(
      Buffer.concat(chunks),
      Buffer.from(value),
      "short writes must retain every byte",
    );
    assert.ok(chunks.length > 1);
  }
});

test("writeLogChunk rejects a write that makes no progress", () => {
  assert.throws(
    () => writeLogChunk(123, "log line\n", () => 0),
    /^Error: log write made no progress$/u,
  );
});

test("createLogCapture retains the first error and keeps draining later chunks without throwing", () => {
  const firstError = new Error("first log failure");
  const laterError = new Error("later log failure");
  const chunks = [];
  const logCapture = createLogCapture(123, (fd, chunk) => {
    assert.equal(fd, 123);
    chunks.push(chunk);
    if (chunk === "first") throw firstError;
    if (chunk === "later") throw laterError;
  });
  assert.equal(logCapture.error, undefined);
  for (const chunk of ["first", "later", "last"]) {
    assert.doesNotThrow(() => logCapture.capture(chunk));
    assert.strictEqual(logCapture.error, firstError);
  }
  assert.deepEqual(chunks, ["first", "later", "last"]);
});

test("creation retains the newest 100 real run directories and preserves other entries", (t) => {
  const { root, base } = fixture(t);
  const names = Array.from(
    { length: 105 },
    (_, index) => `20261006T${String(index).padStart(9, "0")}Z-1`,
  );
  for (const name of names) mkdirSync(join(base, name));
  const unrelated = join(base, "keep-this-directory");
  mkdirSync(unrelated);
  const file = join(base, "20260101T000000000Z-1");
  writeFileSync(file, "keep this file\n");
  const outside = join(root, "outside");
  mkdirSync(outside);
  const marker = join(outside, "marker");
  writeFileSync(marker, "keep target\n");
  const link = join(base, "20260102T000000000Z-1");
  symlinkSync(outside, link, "dir");
  // Recursive removal must unlink an inner symlink without following its target.
  symlinkSync(outside, join(base, names[0], "inner-link"), "dir");
  const warnings = [];
  const directory = makeLogDirectory(root, {
    ...creationOptions,
    warn: (line) => warnings.push(line),
  });

  assert.equal(basename(directory), "20261007T123456789Z-123");
  assert.ok(lstatSync(directory).isDirectory());
  const retained = readdirSync(base).filter((name) => lstatSync(join(base, name)).isDirectory());
  assert.deepEqual(
    retained.sort(),
    [...names.slice(6), basename(directory), basename(unrelated)].sort(),
  );
  assert.equal(retained.length - 1, MAX_GATE_LOG_RUNS);
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readFileSync(file, "utf8"), "keep this file\n");
  assert.equal(readFileSync(marker, "utf8"), "keep target\n");
  assert.deepEqual(warnings, []);
});

test("the run just created survives pruning even when the clock moves backwards", (t) => {
  const { root, base } = fixture(t);
  for (let index = 0; index < 105; index += 1) {
    mkdirSync(join(base, `20990101T${String(index).padStart(9, "0")}Z-1`));
  }
  const directory = makeLogDirectory(root, creationOptions);
  assert.ok(existsSync(directory));
  assert.equal(readdirSync(base).length, MAX_GATE_LOG_RUNS);
});

test(
  "pruning failure warns with its path and still returns the new run",
  { skip: process.getuid?.() === 0 },
  (t) => {
    const { root, base } = fixture(t);
    const blocked = join(base, "20200101T000000000Z-1");
    mkdirSync(blocked);
    writeFileSync(join(blocked, "marker"), "cannot remove without directory access\n");
    chmodSync(blocked, 0o500);
    for (let index = 0; index < 99; index += 1) {
      mkdirSync(join(base, `20261006T${String(index).padStart(9, "0")}Z-1`));
    }
    const warnings = [];
    try {
      const directory = makeLogDirectory(root, {
        ...creationOptions,
        warn: (line) => warnings.push(line),
      });
      assert.ok(existsSync(directory));
      assert.ok(existsSync(blocked));
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].includes(blocked));
      assert.equal(warnings[0].split("\n").length, 1);
    } finally {
      chmodSync(blocked, 0o700);
    }
  },
);

test("a symlinked gate-log base cannot create or prune outside the repository", (t) => {
  const { root, base } = fixture(t);
  const outside = join(root, "outside");
  mkdirSync(outside);
  rmSync(base, { recursive: true });
  symlinkSync(outside, base, "dir");
  assert.throws(() => makeLogDirectory(root, creationOptions), /not a real directory/u);
  assert.deepEqual(readdirSync(outside), []);
});

test("the tail reader returns the last 8 KiB as UTF-8 and handles empty or missing logs", (t) => {
  const { root } = fixture(t);
  const path = join(root, "tail.log");
  const text = `${"discard\n".repeat(2000)}${"ä\n".repeat(3000)}`;
  writeFileSync(path, text);
  const bytes = Buffer.from(text);
  assert.equal(LOG_TAIL_BYTES, 8192);
  assert.equal(readLogTail(path), bytes.subarray(bytes.length - LOG_TAIL_BYTES).toString("utf8"));
  writeFileSync(path, "small log");
  assert.equal(readLogTail(path), "small log");
  writeFileSync(path, "");
  assert.equal(readLogTail(path), "");
  const missing = readLogTail(join(root, "missing\nfile"));
  assert.match(missing, /^Unable to read log tail: .*ENOENT/u);
  assert.equal(missing.split("\n").length, 1);
  assert.match(readLogTail(root), /^Unable to read log tail:/u);
});

test("failure trailers share absolute path formatting for lanes and receipt gates", () => {
  const path = resolve("artifacts/gates/example/contract.log");
  assert.equal(
    formatFailureTrailer("push gate failed: contract", path),
    `push gate failed: contract — log: ${path}`,
  );
  assert.equal(
    formatFailureTrailer("pre-review check failed: bundle", path),
    `pre-review check failed: bundle — log: ${path}`,
  );
  assert.equal(
    formatFailureTrailer(
      "gate failed: backend-test (exit 143, signal SIGTERM)",
      path,
      "transcript",
    ),
    `gate failed: backend-test (exit 143, signal SIGTERM) — transcript: ${path}`,
  );
});
