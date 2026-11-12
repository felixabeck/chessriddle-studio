import { WorkspaceTabScope } from "@/state/tabScope";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStore, Provider } from "jotai";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { engineTerminalFamily, enginesAtom, tabEngineSettingsFamily } from "@/state/atoms";
import { engineIdentity, engineLineContext } from "./analysisLineContext";
import LogsPanel from "./LogsPanel";

const mocks = vi.hoisted(() => ({
  getEngineLogs: vi.fn(),
  notifyUnlessCancelled: vi.fn(),
  renderLogs: vi.fn(),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/files/notifyError", () => ({
  notifyUnlessCancelled: mocks.notifyUnlessCancelled,
}));
vi.mock("@/state/persistError", () => ({ reportPersistError: vi.fn() }));
vi.mock("@/platform/tauri", () => ({
  tauri: {
    getEngineLogs: mocks.getEngineLogs,
    reconcileEngineAttachments: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock("@mantine/core", () => ({
  Select: ({ "aria-label": label }: { "aria-label"?: string }) => <select aria-label={label} />,
  Stack: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../common/EngineLogsView", () => ({
  default: ({
    logs,
    additionalControls,
  }: {
    logs: Array<{ value: string }>;
    additionalControls: React.ReactNode;
  }) => {
    mocks.renderLogs(logs);
    return (
      <>
        {additionalControls}
        <div data-testid="engine-logs">{logs.map((log) => log.value).join("\n")}</div>
      </>
    );
  },
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const engine = {
  type: "local" as const,
  id: "engine-1",
  name: "Stockfish",
  loaded: true,
  handle: { id: { id: "handle-1" }, kind: "engine" as const },
  filename: "stockfish",
  version: "19",
};
let host: HTMLDivElement;
let root: Root;
let store: ReturnType<typeof createStore>;
const settings = { enabled: true, synced: false, go: { t: "Infinite" as const }, settings: [] };
beforeEach(async () => {
  vi.clearAllMocks();
  store = createStore();
  await store.set(enginesAtom, [engine]);
  store.set(tabEngineSettingsFamily({ tab: "tab-1", engineId: engine.id }), settings);
  store.set(engineTerminalFamily({ tab: "tab-1", engine: engine.id }), null);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function render(tab = "tab-1") {
  await act(async () =>
    root.render(
      <Provider store={store}>
        <SWRConfig value={{ provider: () => new Map() }}>
          <WorkspaceTabScope tabId={tab}>
            <LogsPanel />
          </WorkspaceTabScope>
        </SWRConfig>
      </Provider>,
    ),
  );
}
function fail(tab = "tab-1", engineId = engine.id) {
  store.set(engineTerminalFamily({ tab, engine: engineId }), {
    type: "failed",
    searchedKey: "position:",
    fingerprint: "attempt",
    generation: "generation",
    retry: 0,
    context: engineLineContext(settings, engine),
    engineIdentity: engineIdentity(engine),
    snapshot: {
      kind: "process-exit",
      exitStatus: { code: 1, signal: null },
      reason: "Safe reason",
      entries: [
        { type: "infoString", value: "Safe final reason" },
        { type: "stderr", value: "<script>diagnostic</script>" },
        { type: "truncated" },
      ],
    },
  });
}
test("the engine selector has a translated accessible name", async () => {
  mocks.getEngineLogs.mockResolvedValue([]);
  await render();
  expect(host.querySelector("select")?.getAttribute("aria-label")).toBe("Common.Engine");
});
test("a rejected log fetch notifies once and is not rendered as empty success", async () => {
  const failure = new Error("engine disconnected");
  mocks.getEngineLogs.mockRejectedValue(failure);
  await render();
  await vi.waitFor(() => expect(mocks.notifyUnlessCancelled).toHaveBeenCalledTimes(1));
  expect(mocks.notifyUnlessCancelled).toHaveBeenCalledWith("Common.Error", failure);
  expect(mocks.getEngineLogs).toHaveBeenCalledTimes(1);
  expect(mocks.renderLogs).not.toHaveBeenCalled();
});
test("retains terminal diagnostics after actor removal and returns to live logs on a new attempt", async () => {
  mocks.getEngineLogs.mockRejectedValue(new Error("actor removed"));
  fail();
  await render();
  expect(host.textContent).toContain("Engines.Logs.TerminalDiagnostics");
  expect(host.textContent).toContain("Safe final reason");
  expect(host.textContent).toContain("<script>diagnostic</script>");
  expect(host.querySelector("script")).toBeNull();
  expect(host.textContent).toContain("Engines.Logs.TerminalTruncated");
  expect(mocks.getEngineLogs).not.toHaveBeenCalled();
  mocks.getEngineLogs.mockResolvedValue([{ type: "gui", value: "go infinite" }]);
  await act(async () => store.set(engineTerminalFamily({ tab: "tab-1", engine: engine.id }), null));
  await vi.waitFor(() => expect(host.textContent).toContain("go infinite"));
  expect(host.textContent).not.toContain("Engines.Logs.TerminalDiagnostics");
  expect(host.textContent).not.toContain("Safe final reason");
});
test.each(["another-tab", "another-engine"])(
  "does not select diagnostics from %s",
  async (owner) => {
    mocks.getEngineLogs.mockResolvedValue([]);
    fail(owner === "another-tab" ? owner : "tab-1", owner === "another-engine" ? owner : engine.id);
    await render();
    expect(host.textContent).not.toContain("Safe final reason");
    expect(mocks.getEngineLogs).toHaveBeenCalledWith(engine.id, "tab-1");
  },
);
