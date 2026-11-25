import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  formatNestedError,
  installMultiChildSignalForwarding,
  runPassThroughChild,
  signalExitCode,
  superviseChild,
} from "./child-supervisor.mjs";

function makeChild(kill = undefined) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  if (kill) child.kill = kill;
  return child;
}

test("multi-child forwarding treats an already-aborted signal as cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const forwarding = installMultiChildSignalForwarding({
    label: "test child",
    abortSignal: controller.signal,
  });
  let terminations = 0;
  try {
    assert.equal(forwarding.requestedReason, "abort");
    assert.equal(forwarding.requestedSignal, undefined);
    assert.equal(await forwarding.signalRequested, "abort");
    forwarding.attach({ terminate: async () => (terminations += 1) }, "late child");
    await forwarding.termination;
    assert.equal(terminations, 1);
  } finally {
    forwarding.uninstall();
  }
});

test("signal exit codes retain 128 plus signal number and default unknowns to 128", () => {
  assert.equal(signalExitCode("SIGINT"), 130);
  assert.equal(signalExitCode("SIGTERM"), 143);
  assert.equal(signalExitCode("SIG_NOT_A_REAL_SIGNAL"), 128);
  assert.equal(signalExitCode("SIG_NOT_A_REAL_SIGNAL", 1), 1);
});

test("supervisor outcome reports a child exit", async () => {
  const child = makeChild();
  const supervisor = superviseChild(child, { terminationTimeoutMs: 10 });
  const outcome = supervisor.exitOrTerminationFailure();
  child.exitCode = 0;
  child.emit("close", 0, null);

  assert.deepEqual(await outcome, {
    type: "exit",
    result: { code: 0, signal: null, error: undefined },
  });
});

test("supervisor outcome reports a termination failure before a later child exit", async () => {
  const terminationError = Object.assign(new Error("injected EPERM"), { code: "EPERM" });
  const child = makeChild(() => {
    throw terminationError;
  });
  const supervisor = superviseChild(child, { terminationTimeoutMs: 10 });
  const outcome = supervisor.exitOrTerminationFailure();
  const termination = supervisor.terminate();

  assert.deepEqual(await outcome, { type: "termination-failed", error: terminationError });
  await assert.rejects(termination, /injected EPERM/u);
  child.exitCode = 1;
  child.emit("close", 1, null);
  assert.deepEqual(await supervisor.done, { code: 1, signal: null, error: undefined });
});

test("supervisor outcome does not wait for a child after termination fails", async () => {
  const child = makeChild(() => {
    const error = new Error("injected kill failure");
    error.code = "EPERM";
    throw error;
  });
  const supervisor = superviseChild(child, { terminationTimeoutMs: 10 });
  const termination = supervisor.terminate();
  const terminationRejected = assert.rejects(termination, /injected kill failure/u);
  let timer;
  const outcome = await Promise.race([
    supervisor.exitOrTerminationFailure(),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ type: "timeout" }), 250);
    }),
  ]);
  clearTimeout(timer);

  assert.equal(outcome.type, "termination-failed");
  assert.match(outcome.error.message, /injected kill failure/u);
  await terminationRejected;
});

test("nested errors share traversal while callers choose their formatting", () => {
  const error = new AggregateError(
    [new Error("child failure"), new Error("aggregate cause")],
    "root failure",
    { cause: new Error("root cause") },
  );
  assert.equal(
    formatNestedError(error, (message, nested) =>
      nested.length ? `${message}: ${nested.join("; ")}` : message,
    ),
    "root failure: child failure; aggregate cause; root cause",
  );
  assert.equal(
    formatNestedError(error, (message, nested, depth) =>
      [`${"  ".repeat(depth)}${message}`, ...nested].join("\n"),
    ),
    "root failure\n  child failure\n  aggregate cause\n  root cause",
  );
});

function makeStderr() {
  const chunks = [];
  return { chunks, write: (chunk) => chunks.push(chunk) };
}

test("pass-through runner reports spawn failures with exit 127 and the error code", async () => {
  const stderr = makeStderr();
  const thrown = await runPassThroughChild("agent-gate", [], {
    stderr,
    spawnProcess() {
      throw Object.assign(new Error("sync spawn refusal"), { code: "EACCES" });
    },
  });
  assert.deepEqual(thrown, { exitCode: 127, spawnErrorCode: "EACCES" });
  assert.match(stderr.chunks.join(""), /spawn agent-gate failed: sync spawn refusal/u);

  const child = makeChild();
  const pending = runPassThroughChild("agent-gate", [], {
    stderr,
    spawnProcess: () => child,
    signalTarget: new EventEmitter(),
  });
  child.emit("error", Object.assign(new Error("spawn agent-gate ENOENT"), { code: "ENOENT" }));
  assert.deepEqual(await pending, { exitCode: 127, spawnErrorCode: "ENOENT" });
});

test("pass-through runner forwards signals unchanged, reports only non-ESRCH kill failures, and detaches", async () => {
  const stderr = makeStderr();
  const signalTarget = new EventEmitter();
  const kills = [];
  const child = makeChild((signal) => {
    kills.push(signal);
    if (signal === "SIGHUP") throw Object.assign(new Error("gone"), { code: "ESRCH" });
    if (signal === "SIGTERM") throw Object.assign(new Error("denied"), { code: "EPERM" });
    return true;
  });
  const pending = runPassThroughChild("agent-gate", ["node"], {
    stderr,
    spawnProcess: () => child,
    signalTarget,
  });
  for (const signal of ["SIGINT", "SIGHUP", "SIGTERM"]) signalTarget.emit(signal);
  assert.deepEqual(kills, ["SIGINT", "SIGHUP", "SIGTERM"]);
  assert.equal(stderr.chunks.join(""), "Failed to forward SIGTERM to agent-gate: denied\n");

  // Exited but not yet closed: the guard, not listener removal, must hold the signal back.
  child.signalCode = "SIGINT";
  signalTarget.emit("SIGTERM");
  assert.equal(kills.length, 3, "an exited child receives no further signals");
  child.emit("close", null, "SIGINT");
  assert.deepEqual(await pending, { exitCode: 130, spawnErrorCode: undefined });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    assert.equal(signalTarget.listenerCount(signal), 0, `${signal} listener must be removed`);
  }
});
