import { WorkspaceTabScope } from "@/state/tabScope";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Engine } from "@/utils/engines";

const mocks = vi.hoisted(() => ({
  activeTabAtom: Symbol("activeTabAtom"),
  enginesAtom: Symbol("enginesAtom"),
  engines: [] as Engine[],
  notifyUnlessCancelled: vi.fn(),
  setEngines: vi.fn(),
  stopEngine: vi.fn(),
}));

import EngineSelection from "./EngineSelection";

vi.mock("react-i18next", () => ({
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@tanstack/react-router", () => ({ Link: () => <a /> }));
vi.mock("@/components/files/notifyError", () => ({
  notifyUnlessCancelled: mocks.notifyUnlessCancelled,
}));
vi.mock("@/components/engines/InstallStockfishButton", () => ({
  default: () => <button type="button" data-testid="stockfish-install" />,
}));
vi.mock("@/utils/engines", () => ({
  stopEngine: mocks.stopEngine,
  loadDefaultEngineCatalog: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/state/atoms", () => ({
  activeTabAtom: mocks.activeTabAtom,
  enginesAtom: mocks.enginesAtom,
}));
vi.mock("jotai", async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import("jotai")>()),
    useAtomValue: (atom: symbol) => (atom === mocks.activeTabAtom ? "tab-B" : undefined),
    useAtom: () => [mocks.engines, mocks.setEngines],
  };
});
vi.mock("@mantine/core", () => ({
  Center: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Checkbox: ({ checked }: { checked: boolean }) => (
    <input type="checkbox" checked={checked} readOnly />
  ),
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Paper: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Stack: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("lucide-react", () => ({ Cloud: () => null, Brain: () => null }));
vi.mock("@/components/common/LocalImage", () => ({ default: () => null }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.engines = [
    {
      type: "local",
      id: "engine-1",
      name: "Stockfish",
      loaded: true,
      handle: { id: { id: "handle-1" }, kind: "engine" },
      filename: "stockfish",
      version: "17",
    },
  ];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test("the empty selection offers the shared Stockfish installer beside its existing message", async () => {
  mocks.engines = [];
  await act(async () => root.render(<EngineSelection />));
  expect(host.textContent).toContain("Engines.Selection.None");
  expect(host.querySelector('[data-testid="stockfish-install"]')).not.toBeNull();
});

test("a rejected save does not stop the engine and notifies", async () => {
  const failure = new Error("save failed");
  mocks.setEngines.mockRejectedValue(failure);

  await act(async () =>
    root.render(
      <WorkspaceTabScope tabId="tab-A">
        <EngineSelection />
      </WorkspaceTabScope>,
    ),
  );
  await act(async () => {
    host.querySelector("button")!.click();
    await Promise.resolve();
  });

  expect(mocks.stopEngine).not.toHaveBeenCalled();
  expect(mocks.setEngines).toHaveBeenCalledOnce();
  expect(mocks.notifyUnlessCancelled).toHaveBeenCalledWith("Common.Error", failure);
});

test("unload submits a save without issuing a generationless stop", async () => {
  mocks.setEngines.mockResolvedValue({ saved: true });

  await act(async () =>
    root.render(
      <WorkspaceTabScope tabId="tab-A">
        <EngineSelection />
      </WorkspaceTabScope>,
    ),
  );
  await act(async () => {
    host.querySelector("button")!.click();
    await Promise.resolve();
  });

  expect(mocks.setEngines).toHaveBeenCalled();
  expect(mocks.stopEngine).not.toHaveBeenCalled();
});
