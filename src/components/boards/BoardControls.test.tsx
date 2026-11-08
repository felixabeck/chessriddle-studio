import { WorkspaceTabScope } from "@/state/tabScope";
import domtoimage from "dom-to-image";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Provider as JotaiProvider, createStore as createJotaiStore } from "jotai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { activeTabAtom, currentTabAtom, gameStateFamily, tabsAtom } from "@/state/atoms";
import { closeTreeStore, createTreeStore, type TreeStore } from "@/state/store/tree";
import type { Tab } from "@/state/workspaceTypes";
import BoardControls from "./BoardControls";

const mocks = vi.hoisted(() => ({
  persistError: vi.fn(),
  saveBoardSnapshot: vi.fn(),
  notifyUnlessCancelled: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@mantine/core", () => ({
  Stack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("lucide-react", () => ({
  Undo2: () => null,
  Camera: () => null,
  Save: () => null,
  Pencil: () => null,
  PencilOff: () => null,
  Eraser: () => null,
  ArrowUpDown: () => null,
  Target: () => null,
  ScanSearch: () => null,
}));

vi.mock("@/components/common/IconAction", () => ({
  default: ({ label, onClick }: { label: string; onClick?: () => void }) => (
    <button type="button" aria-label={label} onClick={onClick}>
      {label}
    </button>
  ),
}));

vi.mock("@/components/files/notifyError", () => ({
  notifyListenerError: mocks.persistError,
  notifyUnlessCancelled: mocks.notifyUnlessCancelled,
}));

vi.mock("@/platform/native", () => ({
  platform: () => "linux",
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
}));

vi.mock("@/platform/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri");
  return {
    ...actual,
    tauri: { ...actual.tauri, saveBoardSnapshot: mocks.saveBoardSnapshot },
  };
});

vi.mock("dom-to-image", () => ({
  default: { toBlob: vi.fn() },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("BoardControls tab type durability", () => {
  const tabId = "22222222-2222-4222-8222-222222222222";
  const tab: Tab = {
    name: "Analysis",
    value: tabId,
    type: "analysis",
    gameOrigin: { kind: "none" },
  };

  let container: HTMLDivElement;
  let root: Root;
  let jotaiStore: ReturnType<typeof createJotaiStore>;
  let treeStore: TreeStore;
  let boardRef: React.RefObject<HTMLDivElement | null>;

  beforeEach(async () => {
    sessionStorage.clear();
    localStorage.clear();
    mocks.persistError.mockReset();
    mocks.saveBoardSnapshot.mockReset();
    mocks.notifyUnlessCancelled.mockReset();
    vi.mocked(domtoimage.toBlob).mockReset();

    jotaiStore = createJotaiStore();
    jotaiStore.set(tabsAtom, [tab], tabId);
    jotaiStore.set(activeTabAtom, tabId);
    jotaiStore.set(gameStateFamily(tabId), "playing");
    treeStore = createTreeStore(tabId);

    container = document.createElement("div");
    document.body.append(container);
    boardRef = { current: container };
    root = createRoot(container);
    await act(async () => {
      root.render(
        <JotaiProvider store={jotaiStore}>
          <TreeStateContext.Provider value={treeStore}>
            <WorkspaceTabScope tabId={tabId}>
              <BoardControls
                boardRef={boardRef}
                editingMode={false}
                toggleEditingMode={vi.fn()}
                dirty={false}
              />
            </WorkspaceTabScope>
          </TreeStateContext.Provider>
        </JotaiProvider>,
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    closeTreeStore(tabId);
    vi.restoreAllMocks();
  });

  function refuseWorkspaceWrites() {
    const originalSetItem = Storage.prototype.setItem;
    return vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key === "workspace") throw new DOMException("quota", "QuotaExceededError");
        return originalSetItem.call(this, key, value);
      });
  }

  test("snapshots the owned board when an unrelated board appears first", async () => {
    const unrelatedBoard = document.createElement("div");
    unrelatedBoard.className = "cg-wrap";
    document.body.insertBefore(unrelatedBoard, container);
    const snapshotTarget = document.createElement("div");
    snapshotTarget.className = "cg-wrap";
    container.append(snapshotTarget);

    try {
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('[aria-label="Board.Action.TakeSnapshot"]')!
          .click();
      });

      expect(domtoimage.toBlob).toHaveBeenCalledOnce();
      expect(vi.mocked(domtoimage.toBlob).mock.calls[0][0]).toBe(snapshotTarget);
    } finally {
      unrelatedBoard.remove();
    }
  });

  test("does not snapshot when the owning board ref is null", async () => {
    const unrelatedBoard = document.createElement("div");
    unrelatedBoard.className = "cg-wrap";
    container.append(unrelatedBoard);
    boardRef.current = null;

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Board.Action.TakeSnapshot"]')!
        .click();
    });

    expect(domtoimage.toBlob).not.toHaveBeenCalled();
    expect(mocks.saveBoardSnapshot).not.toHaveBeenCalled();
  });

  test("surfaces snapshot save failures without an unhandled rejection", async () => {
    const failure = new Error("snapshot save failed");
    const snapshotTarget = document.createElement("div");
    snapshotTarget.className = "cg-wrap";
    container.append(snapshotTarget);
    vi.mocked(domtoimage.toBlob).mockResolvedValue({
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    } as Blob);
    mocks.saveBoardSnapshot.mockRejectedValue(failure);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Board.Action.TakeSnapshot"]')!
        .click();
    });

    expect(domtoimage.toBlob).toHaveBeenCalledWith(snapshotTarget);
    expect(mocks.saveBoardSnapshot).toHaveBeenCalledWith([1, 2, 3]);
    expect(mocks.notifyUnlessCancelled).toHaveBeenCalledWith("Common.Error", failure);
  });

  test("surfaces snapshot rendering failures without an unhandled rejection", async () => {
    const failure = new Error("snapshot rendering failed");
    const snapshotTarget = document.createElement("div");
    snapshotTarget.className = "cg-wrap";
    container.append(snapshotTarget);
    vi.mocked(domtoimage.toBlob).mockRejectedValue(failure);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Board.Action.TakeSnapshot"]')!
        .click();
    });

    expect(domtoimage.toBlob).toHaveBeenCalledWith(snapshotTarget);
    expect(mocks.saveBoardSnapshot).not.toHaveBeenCalled();
    expect(mocks.notifyUnlessCancelled).toHaveBeenCalledWith("Common.Error", failure);
  });

  test("surfaces snapshot conversion failures without an unhandled rejection", async () => {
    const failure = new Error("snapshot conversion failed");
    const snapshotTarget = document.createElement("div");
    snapshotTarget.className = "cg-wrap";
    container.append(snapshotTarget);
    const arrayBuffer = vi.fn().mockRejectedValue(failure);
    vi.mocked(domtoimage.toBlob).mockResolvedValue({ arrayBuffer } as unknown as Blob);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Board.Action.TakeSnapshot"]')!
        .click();
    });

    expect(domtoimage.toBlob).toHaveBeenCalledWith(snapshotTarget);
    expect(arrayBuffer).toHaveBeenCalled();
    expect(mocks.saveBoardSnapshot).not.toHaveBeenCalled();
    expect(mocks.notifyUnlessCancelled).toHaveBeenCalledWith("Common.Error", failure);
  });

  test("starts a game only after the analysis-to-play change is durable", async () => {
    const durableWorkspace = sessionStorage.getItem("workspace");
    const storageFailure = refuseWorkspaceWrites();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Board.Action.PlayFromHere"]')!
        .click();
    });

    expect(jotaiStore.get(currentTabAtom)?.type).toBe("analysis");
    expect(jotaiStore.get(gameStateFamily(tabId))).toBe("playing");
    expect(sessionStorage.getItem("workspace")).toBe(durableWorkspace);

    storageFailure.mockRestore();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Board.Action.PlayFromHere"]')!
        .click();
    });

    expect(jotaiStore.get(currentTabAtom)?.type).toBe("play");
    expect(jotaiStore.get(gameStateFamily(tabId))).toBe("settingUp");
  });
});
