// Drives the REAL Tauri window, off-screen, with the real Rust backend.
//
//   kwin_wayland --virtual        an off-screen compositor, so nothing reaches the desktop
//     └─ tauri-driver             proxies WebDriver to WebKitWebDriver
//        └─ WebKitWebDriver       launches and controls the app
//           └─ chessriddle-studio the real binary, real IPC, real WebKitGTK
//
// This is the complement to `pnpm test:e2e:container`, not a replacement for it. The container
// suite pins renderer *pixels* in Chromium against a mocked IPC surface; this pins *behaviour* in
// the actual product. Neither answers the other's question.
//
// What it cannot reach: native GTK chrome. The menu bar, file dialogs and window decorations are
// drawn by GTK, not by the page, and WebDriver only sees the page. `issue_engine_binary` in
// particular always opens a native picker, so no engine can be registered from here — a check that
// needs a live engine child is still Felix's.
//
// Prerequisites, all three one-off:
//   sudo apt install webkit2gtk-driver     (must match the installed libwebkit2gtk version)
//   cargo install tauri-driver --locked
//   sudo apt install kwin-wayland

import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export const APP_BINARY = join(projectRoot, "src-tauri", "target", "release", "chessriddle-studio");

const DRIVER_PORT = 4444;
const NATIVE_PORT = 4445;
const FETCH_TIMEOUT_MS = 5_000;
const OUTPUT_LIMIT = 64 * 1024;
const TERM_TIMEOUT_MS = 5_000;
const KILL_TIMEOUT_MS = 2_000;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Everything started here is killed by process *group*: tauri-driver spawns WebKitWebDriver, which
 * spawns the app, which spawns two WebKit service processes. Killing only the parent would leave
 * the tail of that chain behind — which is, with some irony, the exact defect class this harness
 * exists to check for.
 */
const started = [];
const temporaryProfiles = new Set();
let profileDirectory;
let driverOutput;

export function launch(command, args, options = {}) {
  const child = spawn(command, args, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  started.push(child);
  return child;
}

export function registerTemporaryProfile(directory) {
  temporaryProfiles.add(directory);
}

export function outputBuffer() {
  let value = "";
  return {
    push(chunk) {
      value = (value + String(chunk)).slice(-OUTPUT_LIMIT);
    },
    text() {
      return value;
    },
  };
}

function collect(child, sink) {
  child.stdout?.on("data", (chunk) => sink.push(String(chunk)));
  child.stderr?.on("data", (chunk) => sink.push(String(chunk)));
}

async function fetchWithTimeout(url, options = {}, consumeResponse) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return consumeResponse ? await consumeResponse(response) : response;
  } finally {
    clearTimeout(timer);
  }
}

async function readWebDriverResponse(response, operation) {
  const status = `HTTP ${response.status}`;
  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(`${operation} -> ${status}: malformed JSON response`, { cause: error });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`${operation} -> ${status}: malformed WebDriver response envelope`);
  }
  if (!response.ok) throw new Error(`${operation} -> ${status}: WebDriver request failed`);
  if (!Object.hasOwn(body, "value")) {
    throw new Error(`${operation} -> ${status}: response is missing the value envelope`);
  }
  return body.value;
}

export async function waitFor(label, probe, { timeoutMs = 45_000, everyMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error(`timed out waiting for ${label}`);

    let timer;
    const value = await Promise.race([
      Promise.resolve().then(() => probe()),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), remainingMs);
      }),
    ]).finally(() => clearTimeout(timer));
    if (value) return value;

    const delayMs = Math.min(everyMs, deadline - Date.now());
    if (delayMs <= 0) throw new Error(`timed out waiting for ${label}`);
    await sleep(delayMs);
  }
}

export function requirePrerequisites(application = APP_BINARY) {
  const missing = [];
  if (!existsSync("/usr/bin/WebKitWebDriver")) {
    missing.push("WebKitWebDriver — install with: sudo apt install webkit2gtk-driver");
  }
  try {
    execFileSync("sh", ["-c", "command -v tauri-driver"], { stdio: "ignore" });
  } catch {
    missing.push("tauri-driver — install with: cargo install tauri-driver --locked");
  }
  try {
    execFileSync("sh", ["-c", "command -v kwin_wayland"], { stdio: "ignore" });
  } catch {
    missing.push("kwin_wayland — install with: sudo apt install kwin-wayland");
  }
  // `startDriver` silences the app by ranking `fakeaudiosink` first; without the element that
  // ranking is a no-op and `autoaudiosink` falls back to the real output, so its absence is a
  // missing prerequisite, not a degraded run. `--exists` exits 0/1 (measured 2026-09-23).
  try {
    execFileSync("gst-inspect-1.0", ["--exists", "fakeaudiosink"], { stdio: "ignore" });
  } catch {
    missing.push(
      "GStreamer fakeaudiosink — install with: sudo apt install gstreamer1.0-plugins-bad gstreamer1.0-tools",
    );
  }
  if (!existsSync(application)) {
    missing.push(`${application} — build it with: pnpm build`);
  }
  if (missing.length > 0) {
    throw new Error(`missing prerequisites:\n  - ${missing.join("\n  - ")}`);
  }
}

/** An off-screen Wayland compositor. The window never appears on, or takes focus from, the desktop. */
export async function startCompositor({ width = 1400, height = 900 } = {}) {
  const output = outputBuffer();
  const kwin = launch("kwin_wayland", [
    "--virtual",
    "--width",
    String(width),
    "--height",
    String(height),
  ]);
  collect(kwin, output);
  const socket = await waitFor("the nested compositor socket", () => {
    const match = output
      .text()
      .match(/Accepting client connections on sockets: QList\("([^"]+)"\)/);
    return match?.[1];
  });
  return { socket, output: output.text() };
}

/**
 * The app inherits this environment, so `HOME` decides which profile it reads and writes. It gets a
 * throwaway one: `tauri-plugin-window-state` persists geometry on exit, and a headless 1400x900 run
 * must not resize the window Felix actually uses. XDG overrides are removed so they cannot bypass it.
 *
 * The window is off-screen but its audio is not: WebKit plays every move sound through GStreamer's
 * `autoaudiosink`, which lands on Felix's default output — a run clicked in his headset once per
 * move for minutes on 2026-09-23. Ranking `fakeaudiosink` highest makes `autoaudiosink` pick it, so
 * the media pipeline still runs to completion but nothing reaches PipeWire.
 */
export async function startDriver({ waylandDisplay }) {
  const output = outputBuffer();
  driverOutput = output;
  const env = {
    ...process.env,
    WAYLAND_DISPLAY: waylandDisplay,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    GST_PLUGIN_FEATURE_RANK: "fakeaudiosink:MAX",
    // WebKitGTK 2.52.6 has an EGL/Skia GPU-worker teardown race
    // (webkit.org/b/305909, webkit.org/b/315577). Default to CPU painting only
    // for this off-screen verifier. Remove the default after the installed
    // WebKit contains those fixes and passes shutdown validation.
    WEBKIT_SKIA_ENABLE_CPU_RENDERING: process.env.WEBKIT_SKIA_ENABLE_CPU_RENDERING ?? "1",
  };

  try {
    const response = await fetchWithTimeout(`http://127.0.0.1:${DRIVER_PORT}/status`);
    if (response.body) await response.body.cancel().catch(() => {});
    throw new Error(`refusing to start tauri-driver: port ${DRIVER_PORT} is already answering`);
  } catch (error) {
    if (error.message.includes(`port ${DRIVER_PORT} is already answering`)) throw error;
  }

  profileDirectory = await mkdtemp(join(tmpdir(), "chessfable-verify-"));
  env.HOME = profileDirectory;
  for (const name of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
    delete env[name];
  }
  const driver = launch(
    "tauri-driver",
    ["--port", String(DRIVER_PORT), "--native-port", String(NATIVE_PORT)],
    { env },
  );
  collect(driver, output);
  await waitFor(`tauri-driver to accept connections on port ${DRIVER_PORT}`, async () => {
    if (driver.exitCode !== null || driver.signalCode !== null) {
      throw new Error(
        `tauri-driver exited before port ${DRIVER_PORT} became ready ` +
          `(exit code ${driver.exitCode ?? "none"}, signal ${driver.signalCode ?? "none"})`,
      );
    }
    try {
      const response = await fetchWithTimeout(`http://127.0.0.1:${DRIVER_PORT}/status`);
      if (response.body) await response.body.cancel().catch(() => {});
      return true;
    } catch {
      return false;
    }
  });
  return { output: output.text(), profileDirectory, appEnvironment: env };
}

export function driverDiagnostics() {
  return driverOutput?.text() ?? "";
}

/** Minimal WebDriver client. The wire protocol is JSON over HTTP, so this needs no dependency. */
export class Session {
  constructor(id) {
    this.base = `http://127.0.0.1:${DRIVER_PORT}/session/${encodeURIComponent(id)}`;
  }

  static async open(application = APP_BINARY, tauriOptions = {}) {
    let response;
    try {
      response = await fetchWithTimeout(
        `http://127.0.0.1:${DRIVER_PORT}/session`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            capabilities: { alwaysMatch: { "tauri:options": { application, ...tauriOptions } } },
          }),
        },
        async (wireResponse) => ({
          status: wireResponse.status,
          value: await readWebDriverResponse(wireResponse, "POST /session"),
        }),
      );
    } catch (error) {
      throw new Error(
        `WebDriver session creation failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const { status, value } = response;
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof value.sessionId !== "string" ||
      value.sessionId.length === 0
    ) {
      throw new Error(`POST /session -> HTTP ${status}: response is missing a valid session id`);
    }
    return new Session(value.sessionId);
  }

  async call(method, path, payload) {
    return fetchWithTimeout(
      this.base + path,
      {
        method,
        headers: payload ? { "content-type": "application/json" } : undefined,
        body: payload ? JSON.stringify(payload) : undefined,
      },
      (response) => readWebDriverResponse(response, `${method} ${path}`),
    );
  }

  /** Runs in the page, so `window.__TAURI_INTERNALS__` and the real IPC bridge are reachable. */
  execute(script, args = []) {
    return this.call("POST", "/execute/sync", { script, args });
  }

  /** Base64 PNG of the page — not of the window, so GTK chrome is not in it. */
  screenshot() {
    return this.call("GET", "/screenshot");
  }

  async quit() {
    try {
      const response = await fetchWithTimeout(this.base, { method: "DELETE" });
      if (!response.ok) return { released: false, error: `HTTP ${response.status}` };
      return { released: true };
    } catch (error) {
      return {
        released: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/** Processes belonging to the app, by full command line. Used to prove nothing outlives a close. */
export function appProcesses() {
  try {
    const lines = execFileSync("ps", ["-eo", "pid=,ppid=,args="])
      .toString()
      .split("\n")
      .filter((line) => line.trim().length > 0);
    if (lines.length === 0) throw new Error("ps returned no process rows");
    const processes = lines.map((line) => {
      const [pid, ppid, ...command] = line.trim().split(/\s+/);
      const parsed = { pid: Number(pid), ppid: Number(ppid), cmd: command.join(" ") };
      if (!Number.isInteger(parsed.pid) || !Number.isInteger(parsed.ppid) || !parsed.cmd) {
        throw new Error("ps returned a malformed process row");
      }
      return parsed;
    });
    return processes
      .filter(
        ({ cmd }) => cmd.includes(APP_BINARY) || /WebKitWebProcess|WebKitNetworkProcess/.test(cmd),
      )
      .filter(({ cmd }) => !/\bgrep\b/.test(cmd));
  } catch (error) {
    throw new Error(
      `could not inspect application processes with ps: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function groupGone(pid, timeoutMs) {
  await waitFor(`process group ${pid} to exit`, () => !processGroupExists(pid), {
    timeoutMs,
    everyMs: 100,
  });
  return true;
}

export async function cleanUpResources({
  children,
  profileToRemove,
  signalGroup = signalProcessGroup,
  waitForGroup = groupGone,
  groupExists = processGroupExists,
  removeProfile = (path) => rm(path, { recursive: true, force: true }),
}) {
  const groupPids = children.map((child) => child.pid).filter((pid) => Number.isInteger(pid));
  const failures = [];
  const message = (error) => (error instanceof Error ? error.message : String(error));
  const recordWaitFailure = (pid, signal, error) => {
    if (!message(error).startsWith("timed out waiting for process group ")) {
      failures.push(`could not confirm process group ${pid} after ${signal}: ${message(error)}`);
    }
  };

  for (const pid of groupPids) {
    try {
      signalGroup(pid, "SIGTERM");
    } catch (error) {
      failures.push(`could not send SIGTERM to process group ${pid}: ${message(error)}`);
    }
  }

  const termResults = await Promise.all(
    groupPids.map(async (pid) => {
      try {
        return { pid, gone: await waitForGroup(pid, TERM_TIMEOUT_MS) };
      } catch (error) {
        recordWaitFailure(pid, "SIGTERM", error);
        return { pid, gone: false };
      }
    }),
  );
  const termSurvivors = termResults.filter(({ gone }) => !gone).map(({ pid }) => pid);

  for (const pid of termSurvivors) {
    console.error(`cleanup: process group ${pid} survived SIGTERM; escalating to SIGKILL`);
    try {
      signalGroup(pid, "SIGKILL");
    } catch (error) {
      failures.push(`could not send SIGKILL to process group ${pid}: ${message(error)}`);
    }
  }

  await Promise.all(
    termSurvivors.map(async (pid) => {
      try {
        await waitForGroup(pid, KILL_TIMEOUT_MS);
      } catch (error) {
        recordWaitFailure(pid, "SIGKILL", error);
        // The final process-group inspection below decides whether cleanup succeeded.
      }
    }),
  );

  const survivors = [];
  for (const pid of groupPids) {
    try {
      if (groupExists(pid)) survivors.push(pid);
    } catch (error) {
      failures.push(`could not inspect process group ${pid}: ${message(error)}`);
    }
  }

  for (const child of children) {
    for (const stream of [child.stdout, child.stderr]) {
      try {
        stream?.destroy();
      } catch (error) {
        failures.push(`could not release process streams for ${child.pid}: ${message(error)}`);
      }
    }
  }

  if (profileToRemove) {
    try {
      await removeProfile(profileToRemove);
    } catch (error) {
      failures.push(`could not remove temporary profile: ${message(error)}`);
    }
  }

  if (survivors.length > 0) {
    failures.push(`process groups still alive after SIGKILL: ${survivors.join(", ")}`);
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((message) => new Error(message)),
      `cleanup failed: ${failures.join("; ")}`,
    );
  }
}

export async function stopLaunchedChild(child) {
  if (!started.includes(child)) return;
  await cleanUpResources({ children: [child] });
  const index = started.indexOf(child);
  if (index !== -1) started.splice(index, 1);
}

async function cleanUp() {
  const children = started.splice(0).reverse();
  const profileToRemove = profileDirectory;
  profileDirectory = undefined;
  try {
    await cleanUpWithProfiles(
      () => cleanUpResources({ children, profileToRemove }),
      [...temporaryProfiles],
      (path) => rm(path, { recursive: true, force: true }),
    );
  } finally {
    temporaryProfiles.clear();
  }
}

export async function cleanUpWithProfiles(cleanup, profiles, removeProfile) {
  const failures = [];
  try {
    await cleanup();
  } catch (error) {
    failures.push({ error, message: error.message });
  }
  const removals = await Promise.allSettled(
    profiles.map((path) => Promise.resolve().then(() => removeProfile(path))),
  );
  for (const [index, result] of removals.entries()) {
    if (result.status === "rejected") {
      failures.push({
        error: result.reason,
        message: `could not remove temporary profile ${profiles[index]}: ${result.reason.message}`,
      });
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map(({ error }) => error),
      `cleanup failed: ${failures.map(({ message }) => message).join("; ")}`,
    );
  }
}

export function createSharedShutdown(cleanup) {
  let promise;
  return () => {
    if (!promise) promise = Promise.resolve().then(cleanup);
    return promise;
  };
}

const sharedShutdown = createSharedShutdown(cleanUp);

export function shutdown() {
  return sharedShutdown();
}
