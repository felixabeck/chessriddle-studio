import { spawn as defaultSpawn } from "node:child_process";
import { constants as osConstants } from "node:os";

const PROCESS_GROUP_POLL_MS = 10;

// Two seconds lets a gate handle SIGTERM cleanly before the supervisor escalates to SIGKILL
// (its process group when supervised with killProcessGroup).
export const CHILD_TERMINATION_TIMEOUT_MS = 2_000;

/** Traverse nested errors once while letting each caller choose how to format their tree. */
export function formatNestedError(error, format, depth = 0) {
  const message = error instanceof Error ? error.message : String(error);
  const nested = error instanceof AggregateError ? [...error.errors] : [];
  if (error?.cause !== undefined) nested.push(error.cause);
  const formattedNested = nested.map((cause) => formatNestedError(cause, format, depth + 1));
  return format(message, formattedNested, depth);
}

/** Translate a child signal to its conventional shell status. Unknown signals default to 128. */
export function signalExitCode(signal, unknownSignalCode = 128) {
  const number = osConstants.signals[signal];
  return typeof number === "number" ? 128 + number : unknownSignalCode;
}

const PASS_THROUGH_FORWARDED_SIGNALS = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP"]);

function oneLineMessage(error) {
  return (error instanceof Error ? error.message : String(error)).replaceAll(/[\r\n]+/gu, " ");
}

/**
 * Run one child with inherited stdio as a transparent stand-in for this process: forward
 * SIGINT/SIGTERM/SIGHUP to it unchanged (never escalating to SIGKILL, so the child finishes its
 * own cleanup), wait for it to close, and resolve `{ exitCode, spawnErrorCode }`. A signal death
 * maps through `signalExitCode`; a spawn failure resolves exit 127 with the error's `code`.
 */
export async function runPassThroughChild(
  executable,
  args,
  {
    cwd = process.cwd(),
    env = process.env,
    stderr = process.stderr,
    spawnProcess = defaultSpawn,
    signalTarget = process,
  } = {},
) {
  let child;
  try {
    child = spawnProcess(executable, args, { cwd, env, stdio: "inherit", detached: false });
  } catch (error) {
    stderr.write(`spawn ${executable} failed: ${oneLineMessage(error)}\n`);
    return { exitCode: 127, spawnErrorCode: error?.code };
  }

  const forwardSignal = (signal) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill(signal);
    } catch (error) {
      if (error?.code !== "ESRCH") {
        stderr.write(`Failed to forward ${signal} to ${executable}: ${oneLineMessage(error)}\n`);
      }
    }
  };
  const signalListeners = PASS_THROUGH_FORWARDED_SIGNALS.map((signal) => {
    const listener = () => forwardSignal(signal);
    signalTarget.on(signal, listener);
    return [signal, listener];
  });

  try {
    return await new Promise((resolveExit) => {
      let settled = false;
      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        resolveExit(outcome);
      };
      child.once("error", (error) => {
        stderr.write(`spawn ${executable} failed: ${oneLineMessage(error)}\n`);
        finish({ exitCode: 127, spawnErrorCode: error?.code });
      });
      child.once("close", (code, signal) => {
        if (signal !== null) {
          const exitCode = signalExitCode(signal);
          stderr.write(`${executable} terminated by signal ${signal} (exit ${exitCode})\n`);
          finish({ exitCode, spawnErrorCode: undefined });
          return;
        }
        finish({ exitCode: code ?? 1, spawnErrorCode: undefined });
      });
    });
  } finally {
    for (const [signal, listener] of signalListeners) {
      signalTarget.off(signal, listener);
    }
  }
}

function childIsRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

function signalChild(child, signal, killProcessGroup, { allowExitedGroup = false } = {}) {
  try {
    if (killProcessGroup) {
      if (child.pid === undefined) return false;
      if (!allowExitedGroup && !childIsRunning(child)) return false;
      process.kill(-child.pid, signal);
      return true;
    }
    if (!childIsRunning(child)) return false;
    return child.kill(signal);
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function sweepProcessGroup(child) {
  if (child.pid === undefined) return;
  signalChild(child, "SIGKILL", true, { allowExitedGroup: true });
  while (true) {
    try {
      process.kill(-child.pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, PROCESS_GROUP_POLL_MS));
  }
}

export function superviseChild(child, { terminationTimeoutMs, killProcessGroup = false }) {
  const childDone = new Promise((resolve) => {
    let spawnError;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => resolve({ code, signal, error: spawnError }));
  });
  const done = (async () => {
    const result = await childDone;
    if (killProcessGroup) await sweepProcessGroup(child);
    return result;
  })();
  let termination;
  let resolveTerminationFailure;
  const terminationFailure = new Promise((resolve) => {
    resolveTerminationFailure = resolve;
  });
  const unref = () => {
    child.unref?.();
    child.stdout?.destroy?.();
    child.stderr?.destroy?.();
  };

  return {
    done,
    exitOrTerminationFailure() {
      return Promise.race([done.then((result) => ({ type: "exit", result })), terminationFailure]);
    },
    unref,
    terminate() {
      if (termination) return termination;
      termination = (async () => {
        signalChild(child, "SIGTERM", killProcessGroup);
        let escalationTimer;
        const escalation = new Promise((resolve, reject) => {
          escalationTimer = setTimeout(() => {
            try {
              signalChild(child, "SIGKILL", killProcessGroup);
              resolve();
            } catch (error) {
              reject(error);
            }
          }, terminationTimeoutMs);
        });
        try {
          await Promise.race([done, escalation]);
          return await done;
        } finally {
          clearTimeout(escalationTimer);
        }
      })();
      termination.catch((error) => {
        unref();
        resolveTerminationFailure({ type: "termination-failed", error });
      });
      return termination;
    },
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Attempt every child termination and report all failures after every attempt settles. */
async function terminateChildren(children, label) {
  const entries = [...children];
  const results = await Promise.allSettled(
    entries.map((entry) => {
      if (!entry.termination) {
        entry.termination = Promise.resolve().then(() => entry.supervisor.terminate());
      }
      return entry.termination;
    }),
  );
  const failures = results.flatMap((result, index) => {
    if (result.status === "fulfilled") return [];
    const { name } = entries[index];
    return [
      new Error(`Failed to terminate ${label} child ${name}: ${errorMessage(result.reason)}`, {
        cause: result.reason,
      }),
    ];
  });
  if (failures.length > 0) {
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") entries[index].supervisor.unref?.();
    }
    throw new AggregateError(failures, `Failed to terminate ${failures.length} ${label} child(s).`);
  }
}

/** Forward runner signals to every attached child and latch attachment into termination. */
export function installMultiChildSignalForwarding({ label, abortSignal = undefined } = {}) {
  if (typeof label !== "string" || label.trim() === "") {
    throw new TypeError("A non-empty child label is required for signal forwarding.");
  }

  let requestedSignal;
  let requestedReason;
  let resolveSignalRequested;
  const signalRequested = new Promise((resolve) => {
    resolveSignalRequested = resolve;
  });
  const children = [];
  const terminationBatches = [];
  const terminateAll = () => {
    const termination = terminateChildren(children, label);
    terminationBatches.push(termination);
    termination.catch(() => {});
    return termination;
  };
  const requestTermination = (reason) => {
    if (requestedReason !== undefined) return;
    requestedReason = reason;
    if (reason === "SIGINT" || reason === "SIGTERM") requestedSignal = reason;
    resolveSignalRequested(reason);
    terminateAll();
  };
  const handler = (signal) => requestTermination(signal);
  const onAbort = () => requestTermination("abort");
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  if (abortSignal?.aborted) onAbort();
  else abortSignal?.addEventListener("abort", onAbort, { once: true });
  return {
    get requestedSignal() {
      return requestedSignal;
    },
    get requestedReason() {
      return requestedReason;
    },
    signalRequested,
    get termination() {
      return Promise.allSettled(terminationBatches).then((results) => {
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length > 0) {
          throw new AggregateError(failures, `${label} signal cleanup failed.`);
        }
      });
    },
    attach(supervisor, name) {
      children.push({ supervisor, name });
      if (requestedReason !== undefined) terminateAll();
    },
    terminateAll,
    uninstall() {
      process.off("SIGINT", handler);
      process.off("SIGTERM", handler);
      abortSignal?.removeEventListener("abort", onAbort);
    },
  };
}
