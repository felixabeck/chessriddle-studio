import { WorkspaceTabScope } from "@/state/tabScope";
import { MantineProvider } from "@mantine/core";
import domtoimage from "dom-to-image";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Provider as JotaiProvider, createStore as createJotaiStore } from "jotai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import {
  activeTabAtom,
  currentTabAtom,
  gameInputColorAtom,
  playFromHereColorFamily,
  gameStateFamily,
  tabsAtom,
} from "@/state/atoms";
import { defaultBoardArrangement } from "@/state/boardArrangement";
import { defaultKindLayouts } from "@/state/layoutPresets";
import { BOARD_LAYOUTS_VERSION, boardLayoutsAtom } from "@/state/layoutStorage";
import {
  closeTreeStore,
  createTreeStore,
  getCachedTreeStore,
  type TreeStore,
} from "@/state/store/tree";
import type { Tab } from "@/state/workspaceTypes";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { focusedDialogButton, press } from "@/tests/keyboard";
import BoardControls from "./BoardControls";

installResizeObserverStub();

const mocks = vi.hoisted(() => ({
  persistError: vi.fn(),
  saveBoardSnapshot: vi.fn(),
  notifyUnlessCancelled: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("lucide-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("lucide-react")>()),
  Undo2: () => null,
  BookmarkPlus: () => null,
  Camera: () => null,
  Check: () => null,
  Save: () => null,
  Database: () => null,
  Ellipsis: () => null,
  LayoutGrid: () => null,
  Pencil: () => null,
  PencilOff: () => null,
  ArrowUpDown: () => null,
  Target: () => null,
  ScanSearch: () => null,
}));

vi.mock("@/components/common/IconAction", () => ({
  default: ({
    label,
    onClick,
    pending,
    disabled,
    ...props
  }: {
    label: string;
    onClick?: () => void;
    pending?: boolean;
    disabled?: boolean;
  } & Record<string, unknown>) => (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      data-pending={pending ? "true" : "false"}
      {...props}
    >
      {label}
    </button>
  ),
}));

vi.mock("@/components/files/notifyError", () => ({
  notifyListenerError: mocks.persistError,
  notifyUnlessCancelled: mocks.notifyUnlessCancelled,
}));

vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));

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

describe("BoardControls", () => {
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
    installMatchMediaStub();
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
    await renderControls({});
  });

  afterEach(async () => {
    const openTabs = jotaiStore.get(tabsAtom);
    await act(async () => root.unmount());
    container.remove();
    closeTreeStore(tabId);
    for (const open of openTabs) closeTreeStore(open.value);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

  async function renderControls(props: Partial<React.ComponentProps<typeof BoardControls>>) {
    await act(async () => {
      root.render(
        <MantineProvider>
          <JotaiProvider store={jotaiStore}>
            <TreeStateContext.Provider value={treeStore}>
              <WorkspaceTabScope tabId={tabId}>
                <BoardControls
                  boardRef={boardRef}
                  editingMode={false}
                  toggleEditingMode={vi.fn()}
                  dirty={false}
                  {...props}
                />
              </WorkspaceTabScope>
            </TreeStateContext.Provider>
          </JotaiProvider>
        </MantineProvider>,
      );
    });
  }

  const actionButton = (label: string) =>
    container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  const takeBackButton = () => actionButton("Board.Action.TakeBack");
  const moreButton = () => actionButton("Board.Action.More");
  const menuItems = () => [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]'),
  ];
  const menuItem = (label: string) =>
    menuItems().find((item) => item.textContent?.includes(label)) ?? null;

  async function openMoreMenu() {
    await act(async () => moreButton()!.click());
    await vi.waitFor(() => expect(menuItems().length).toBeGreaterThan(0));
  }

  async function triggerSnapshotFromMenu() {
    await openMoreMenu();
    await act(async () => menuItem("Board.Action.TakeSnapshot")!.click());
  }

  test("analysis screen shows Play from here, Flip board, and More menu without Undo/Redo/Clear drawings", async () => {
    await renderControls({ saveFile: vi.fn(), saveTo: vi.fn() });

    expect(actionButton("Board.Action.PlayFromHere")).not.toBeNull();
    expect(actionButton("Board.Action.FlipBoard")).not.toBeNull();
    expect(moreButton()).not.toBeNull();
    expect(actionButton("Board.Action.SavePGN")).toBeNull();
    expect(actionButton("Board.Action.Undo")).toBeNull();
    expect(actionButton("Board.Action.Redo")).toBeNull();
    expect(actionButton("Board.Action.ClearDrawings")).toBeNull();

    await openMoreMenu();
    expect(menuItems().map((el) => el.textContent)).toEqual([
      expect.stringContaining("Board.Database.Save"),
      expect.stringContaining("Board.Action.TakeSnapshot"),
      expect.stringContaining("Board.Action.EditPosition"),
    ]);
  });

  test("game screen shows Take back (when allowed), Analyze game, Flip board, and More menu", async () => {
    await act(async () => {
      jotaiStore.set(tabsAtom, [{ ...tab, type: "play" }], tabId);
    });
    await renderControls({
      canTakeBack: true,
      onTakeBack: vi.fn(),
      disableVariations: true,
      allowEditing: false,
    });

    expect(takeBackButton()).not.toBeNull();
    expect(actionButton("Board.Action.AnalyzeGame")).not.toBeNull();
    expect(actionButton("Board.Action.FlipBoard")).not.toBeNull();
    expect(actionButton("Board.Action.SavePGN")).toBeNull();
    expect(moreButton()).not.toBeNull();

    await openMoreMenu();
    expect(menuItem("Board.Database.Save")).toBeNull();
    expect(menuItem("Board.Action.TakeSnapshot")).not.toBeNull();
    expect(menuItem("Board.Action.EditPosition")).toBeNull();
  });

  test("game screen More menu offers Edit position only while setting up, and shows its on state", async () => {
    await act(async () => {
      jotaiStore.set(tabsAtom, [{ ...tab, type: "play" }], tabId);
    });
    await renderControls({
      disableVariations: true,
      allowEditing: true,
      editingMode: true,
    });

    await openMoreMenu();
    const editItem = menuItem("Board.Action.EditPosition");
    expect(editItem).not.toBeNull();
    expect(editItem!.getAttribute("aria-checked")).toBe("true");
  });

  test("Save button visibility follows dirty, autoSaveActive, and autoSaveFailed", async () => {
    const saveFile = vi.fn();

    // Clean tree with autoSaveActive off: hidden.
    await renderControls({ dirty: false, saveFile, autoSaveActive: false });
    expect(actionButton("Board.Action.SavePGN")).toBeNull();

    // Dirty tree with autoSaveActive off: visible.
    await renderControls({ dirty: true, saveFile, autoSaveActive: false });
    expect(actionButton("Board.Action.SavePGN")).not.toBeNull();

    // Dirty tree with autoSaveActive on and no failure: hidden.
    await renderControls({ dirty: true, saveFile, autoSaveActive: true, autoSaveFailed: false });
    expect(actionButton("Board.Action.SavePGN")).toBeNull();

    // Dirty tree with autoSaveActive on and autoSaveFailed: visible.
    await renderControls({ dirty: true, saveFile, autoSaveActive: true, autoSaveFailed: true });
    expect(actionButton("Board.Action.SavePGN")).not.toBeNull();

    // Missing saveFile handler: hidden even when dirty and failing.
    await renderControls({ dirty: true, saveFile: undefined, autoSaveFailed: true });
    expect(actionButton("Board.Action.SavePGN")).toBeNull();
  });

  test("toolbar and menu clicks flip orientation with root.fen, save, save to database, toggle edit position, and take snapshot", async () => {
    const saveFile = vi.fn();
    const saveTo = vi.fn();
    const toggleEditingMode = vi.fn();
    const snapshotTarget = document.createElement("div");
    snapshotTarget.className = "cg-wrap";
    container.append(snapshotTarget);
    vi.mocked(domtoimage.toBlob).mockResolvedValueOnce({
      arrayBuffer: async () => new Uint8Array([9, 8]).buffer,
    } as Blob);
    mocks.saveBoardSnapshot.mockResolvedValueOnce(null);

    await act(async () => {
      treeStore.getState().setHeaders({
        ...treeStore.getState().headers,
        orientation: "white",
      });
    });
    const setHeadersSpy = vi.spyOn(treeStore.getState(), "setHeaders");

    await renderControls({
      dirty: true,
      saveFile,
      saveTo,
      toggleEditingMode,
    });

    await act(async () => actionButton("Board.Action.FlipBoard")!.click());
    expect(setHeadersSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        orientation: "black",
        fen: treeStore.getState().root.fen,
      }),
    );

    await act(async () => actionButton("Board.Action.SavePGN")!.click());
    expect(saveFile).toHaveBeenCalledOnce();

    await openMoreMenu();
    await act(async () => menuItem("Board.Database.Save")!.click());
    expect(saveTo).toHaveBeenCalledOnce();

    await openMoreMenu();
    await act(async () => menuItem("Board.Action.EditPosition")!.click());
    expect(toggleEditingMode).toHaveBeenCalledOnce();

    await triggerSnapshotFromMenu();
    expect(domtoimage.toBlob).toHaveBeenCalledWith(snapshotTarget);
    expect(mocks.saveBoardSnapshot).toHaveBeenCalledWith([9, 8]);
  });

  test("actions container and menu trigger carry data-no-drag", () => {
    const trigger = moreButton()!;
    expect(trigger.getAttribute("data-no-drag")).toBe("true");
    expect(trigger.closest('[data-no-drag="true"]')).not.toBeNull();
  });

  test("a game that can take back renders the control and runs the takeback on click", async () => {
    const onTakeBack = vi.fn();
    await renderControls({ canTakeBack: true, onTakeBack, takeBackPending: false });

    expect(takeBackButton()).not.toBeNull();
    expect(takeBackButton()!.dataset.pending).toBe("false");
    await act(async () => takeBackButton()!.click());

    expect(onTakeBack).toHaveBeenCalledOnce();
  });

  test("a pending takeback reaches the control", async () => {
    await renderControls({ canTakeBack: true, onTakeBack: vi.fn(), takeBackPending: true });

    expect(takeBackButton()!.dataset.pending).toBe("true");
  });

  test.each([
    { canTakeBack: false, onTakeBack: vi.fn() },
    { canTakeBack: true, onTakeBack: undefined },
    {},
  ])("without both a takeback permission and handler there is no control (%o)", async (props) => {
    await renderControls(props);

    expect(takeBackButton()).toBeNull();
  });

  test("snapshots the owned board when an unrelated board appears first", async () => {
    const unrelatedBoard = document.createElement("div");
    unrelatedBoard.className = "cg-wrap";
    document.body.insertBefore(unrelatedBoard, container);
    const snapshotTarget = document.createElement("div");
    snapshotTarget.className = "cg-wrap";
    container.append(snapshotTarget);

    try {
      await triggerSnapshotFromMenu();

      expect(domtoimage.toBlob).toHaveBeenCalledOnce();
      expect(vi.mocked(domtoimage.toBlob).mock.calls[0][0]).toBe(snapshotTarget);
    } finally {
      unrelatedBoard.remove();
    }
  });

  test("ignores a second snapshot trigger while an export is in flight, and allows one after it settles", async () => {
    const snapshotTarget = document.createElement("div");
    snapshotTarget.className = "cg-wrap";
    container.append(snapshotTarget);
    const blobDeferred = Promise.withResolvers<Blob>();
    vi.mocked(domtoimage.toBlob).mockReturnValueOnce(blobDeferred.promise);

    // First trigger via shortcut starts export.
    press("s", { ctrlKey: true, shiftKey: true });
    expect(domtoimage.toBlob).toHaveBeenCalledTimes(1);

    // Second trigger while in flight is ignored.
    press("s", { ctrlKey: true, shiftKey: true });
    expect(domtoimage.toBlob).toHaveBeenCalledTimes(1);

    // Resolve export and save dialog.
    const saveDeferred = Promise.withResolvers<null>();
    mocks.saveBoardSnapshot.mockReturnValueOnce(saveDeferred.promise);
    await act(async () => {
      blobDeferred.resolve({
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      } as Blob);
    });
    // Still in flight while saveBoardSnapshot is pending.
    press("s", { ctrlKey: true, shiftKey: true });
    expect(domtoimage.toBlob).toHaveBeenCalledTimes(1);

    await act(async () => {
      saveDeferred.resolve(null);
    });

    // After completion, a new trigger runs normally.
    vi.mocked(domtoimage.toBlob).mockResolvedValueOnce({
      arrayBuffer: async () => new Uint8Array([4, 5]).buffer,
    } as Blob);
    mocks.saveBoardSnapshot.mockResolvedValueOnce(null);
    await act(async () => {
      press("s", { ctrlKey: true, shiftKey: true });
    });
    expect(domtoimage.toBlob).toHaveBeenCalledTimes(2);
  });

  test("does not snapshot when the owning board ref is null", async () => {
    const unrelatedBoard = document.createElement("div");
    unrelatedBoard.className = "cg-wrap";
    container.append(unrelatedBoard);
    boardRef.current = null;

    await triggerSnapshotFromMenu();

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

    await triggerSnapshotFromMenu();

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

    await triggerSnapshotFromMenu();

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

    await triggerSnapshotFromMenu();

    expect(domtoimage.toBlob).toHaveBeenCalledWith(snapshotTarget);
    expect(arrayBuffer).toHaveBeenCalled();
    expect(mocks.saveBoardSnapshot).not.toHaveBeenCalled();
    expect(mocks.notifyUnlessCancelled).toHaveBeenCalledWith("Common.Error", failure);
  });

  test("new shortcuts invoke their actions, respect game-screen setup gating, and stay silent in inputs and dialogs", async () => {
    const toggleEditingMode = vi.fn();
    const saveTo = vi.fn();
    const snapshotTarget = document.createElement("div");
    snapshotTarget.className = "cg-wrap";
    container.append(snapshotTarget);
    vi.mocked(domtoimage.toBlob).mockResolvedValue({
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    } as Blob);
    mocks.saveBoardSnapshot.mockResolvedValue(null);

    await renderControls({ toggleEditingMode, saveTo });

    press("e");
    expect(toggleEditingMode).toHaveBeenCalledTimes(1);

    press("d", { ctrlKey: true, shiftKey: true });
    expect(saveTo).toHaveBeenCalledTimes(1);

    await act(async () => {
      press("s", { ctrlKey: true, shiftKey: true });
    });
    expect(domtoimage.toBlob).toHaveBeenCalledTimes(1);

    // Focused input ignores all three shortcuts.
    const input = document.createElement("input");
    container.append(input);
    act(() => input.focus());
    press("e", { target: input });
    press("d", { ctrlKey: true, shiftKey: true, target: input });
    press("s", { ctrlKey: true, shiftKey: true, target: input });
    expect(toggleEditingMode).toHaveBeenCalledTimes(1);
    expect(saveTo).toHaveBeenCalledTimes(1);
    expect(domtoimage.toBlob).toHaveBeenCalledTimes(1);

    // Focused blocking dialog ignores all three shortcuts.
    const { dialog, button } = focusedDialogButton(container);
    press("e", { target: button });
    press("d", { ctrlKey: true, shiftKey: true, target: button });
    press("s", { ctrlKey: true, shiftKey: true, target: button });
    expect(toggleEditingMode).toHaveBeenCalledTimes(1);
    expect(saveTo).toHaveBeenCalledTimes(1);
    expect(domtoimage.toBlob).toHaveBeenCalledTimes(1);
    dialog.remove();
    input.remove();

    // On the game screen outside setup, Edit position and Save to database do nothing; Snapshot still works.
    await renderControls({
      toggleEditingMode,
      saveTo: undefined,
      disableVariations: true,
      allowEditing: false,
    });
    press("e");
    press("d", { ctrlKey: true, shiftKey: true });
    expect(toggleEditingMode).toHaveBeenCalledTimes(1);
    expect(saveTo).toHaveBeenCalledTimes(1);
    await act(async () => {
      press("s", { ctrlKey: true, shiftKey: true });
    });
    expect(domtoimage.toBlob).toHaveBeenCalledTimes(2);

    // On the game screen during setup, Edit position works again.
    await renderControls({
      toggleEditingMode,
      saveTo: undefined,
      disableVariations: true,
      allowEditing: true,
    });
    press("e");
    expect(toggleEditingMode).toHaveBeenCalledTimes(2);
  });

  test("opens a play tab only after the new-tab workspace write is durable", async () => {
    const durableWorkspace = sessionStorage.getItem("workspace");
    const storageFailure = refuseWorkspaceWrites();

    await act(async () => {
      actionButton("Board.Action.PlayFromHere")!.click();
    });

    expect(jotaiStore.get(tabsAtom)).toEqual([tab]);
    expect(jotaiStore.get(currentTabAtom)?.type).toBe("analysis");
    expect(jotaiStore.get(gameStateFamily(tabId))).toBe("playing");
    expect(sessionStorage.getItem("workspace")).toBe(durableWorkspace);

    storageFailure.mockRestore();
    await act(async () => {
      actionButton("Board.Action.PlayFromHere")!.click();
    });

    const tabs = jotaiStore.get(tabsAtom);
    expect(tabs.find((open) => open.value === tabId)?.type).toBe("analysis");
    const playTab = tabs.find((open) => open.type === "play");
    expect(playTab).toMatchObject({
      name: "Home.NewGame",
      type: "play",
      gameOrigin: { kind: "none" },
    });
    expect(jotaiStore.get(gameStateFamily(tabId))).toBe("playing");
    expect(jotaiStore.get(gameStateFamily(playTab!.value))).toBe("settingUp");
  });

  test("Play from here seeds a new play tab from the current line and leaves analysis intact", async () => {
    await act(async () => {
      jotaiStore.set(gameInputColorAtom, "random");
      treeStore.getState().makeMoves({ payload: ["e4", "e5", "Nf3"] });
      treeStore.getState().goToMove([0]);
      treeStore.getState().makeMove({ payload: "c5" });
      treeStore.getState().setComment("sicilian");
      treeStore.getState().setHeaders({
        ...treeStore.getState().headers,
        fen: treeStore.getState().root.fen,
        orientation: "black",
      });
    });
    const analysisRoot = treeStore.getState().root;

    await act(async () => {
      actionButton("Board.Action.PlayFromHere")!.click();
    });

    const tabs = jotaiStore.get(tabsAtom);
    expect(tabs.find((open) => open.value === tabId)?.type).toBe("analysis");
    expect(treeStore.getState().root).toBe(analysisRoot);
    expect(analysisRoot.children.map((node) => node.san)).toEqual(["e4"]);
    expect(analysisRoot.children[0].children.map((node) => node.san)).toEqual(["e5", "c5"]);
    expect(analysisRoot.children[0].children[1].comment).toBe("sicilian");
    expect(analysisRoot.children[0].children[0].children.map((node) => node.san)).toEqual(["Nf3"]);

    const playTab = tabs.find((open) => open.type === "play");
    expect(playTab).toMatchObject({
      name: "Home.NewGame",
      type: "play",
      gameOrigin: { kind: "none" },
    });
    const playStore = getCachedTreeStore(playTab!.value) ?? createTreeStore(playTab!.value);
    const playState = playStore.getState();
    expect(playState.headers.orientation).toBe("black");
    expect(playState.position).toEqual([0, 0]);
    expect(playState.root.children.map((node) => node.san)).toEqual(["e4"]);
    expect(playState.root.children[0].children.map((node) => node.san)).toEqual(["c5"]);
    expect(playState.root.children[0].children[0].comment).toBe("");
    expect(playState.root.children[0].children[0].children).toEqual([]);
    expect(jotaiStore.get(activeTabAtom)).toBe(playTab!.value);
    expect(jotaiStore.get(playFromHereColorFamily(playTab!.value))).toEqual({ chosen: null });
    expect(jotaiStore.get(gameInputColorAtom)).toBe("random");
  });

  test.each(["white", "black", "random"] as const)(
    "Play from here after 1.e4 writes a seed and leaves global colour %s",
    async (prior) => {
      await act(async () => {
        jotaiStore.set(gameInputColorAtom, prior);
        treeStore.getState().makeMove({ payload: "e4" });
      });

      await act(async () => {
        actionButton("Board.Action.PlayFromHere")!.click();
      });

      const playTab = jotaiStore.get(tabsAtom).find((open) => open.type === "play");
      expect(jotaiStore.get(playFromHereColorFamily(playTab!.value))).toEqual({ chosen: null });
      expect(jotaiStore.get(gameInputColorAtom)).toBe(prior);
    },
  );

  test("Play from here at a black-to-move root FEN writes a seed and leaves global colour", async () => {
    await act(async () => {
      jotaiStore.set(gameInputColorAtom, "white");
      treeStore.getState().setFen("8/8/8/4k3/8/8/4P3/4K3 b - - 0 1");
    });
    expect(treeStore.getState().position).toEqual([]);

    await act(async () => {
      actionButton("Board.Action.PlayFromHere")!.click();
    });

    const playTab = jotaiStore.get(tabsAtom).find((open) => open.type === "play");
    expect(jotaiStore.get(playFromHereColorFamily(playTab!.value))).toEqual({ chosen: null });
    expect(jotaiStore.get(gameInputColorAtom)).toBe("white");
  });

  test("converts a play tab to analysis in place without opening another tab", async () => {
    await act(async () => {
      jotaiStore.set(tabsAtom, [{ ...tab, type: "play" }], tabId);
    });

    await act(async () => {
      actionButton("Board.Action.AnalyzeGame")!.click();
    });

    expect(jotaiStore.get(tabsAtom)).toEqual([{ ...tab, type: "analysis" }]);
    expect(jotaiStore.get(gameStateFamily(tabId))).toBe("playing");
  });

  test("More menu shows the Layout section on the analysis board without check marks, and omits it on the play board", async () => {
    const onApplyLayout = vi.fn();
    const onSaveLayoutAs = vi.fn();
    const onManageLayouts = vi.fn();
    jotaiStore.set(boardLayoutsAtom, {
      version: BOARD_LAYOUTS_VERSION,
      kinds: defaultKindLayouts(),
      saved: [
        {
          id: "saved-custom",
          name: "My Study",
          arrangement: defaultBoardArrangement(),
          tabsHidden: false,
        },
      ],
    });

    await renderControls({
      saveTo: vi.fn(),
      onApplyLayout,
      onSaveLayoutAs,
      onManageLayouts,
    });
    await openMoreMenu();

    expect(document.body.textContent).toContain("Board.Layout.Section");
    const repertoireItem = menuItem("Board.Layout.Preset.Repertoire");
    const gameReviewItem = menuItem("Board.Layout.Preset.GameReview");
    const preparationItem = menuItem("Board.Layout.Preset.Preparation");
    const savedItem = menuItem("My Study");
    const saveAsItem = menuItem("Board.Layout.SaveAs");
    const manageItem = menuItem("Board.Layout.Manage");
    expect(repertoireItem).not.toBeNull();
    expect(gameReviewItem).not.toBeNull();
    expect(preparationItem).not.toBeNull();
    expect(savedItem).not.toBeNull();
    expect(saveAsItem).not.toBeNull();
    expect(manageItem).not.toBeNull();

    // Layout items carry no check mark / checkbox role.
    for (const item of [repertoireItem!, gameReviewItem!, preparationItem!, savedItem!]) {
      expect(item.getAttribute("role")).toBe("menuitem");
      expect(item.hasAttribute("aria-checked")).toBe(false);
    }

    await act(async () => savedItem!.click());
    expect(onApplyLayout).toHaveBeenCalledWith("saved-custom");

    await openMoreMenu();
    await act(async () => menuItem("Board.Layout.SaveAs")!.click());
    expect(onSaveLayoutAs).toHaveBeenCalledOnce();

    await openMoreMenu();
    await act(async () => menuItem("Board.Layout.Manage")!.click());
    expect(onManageLayouts).toHaveBeenCalledOnce();
    // "Show the tabs" appears only while the board passes onShowTabs (its tab strip is hidden).
    await openMoreMenu();
    expect(menuItem("Board.Arrange.ShowTabs")).toBeNull();

    const onShowTabs = vi.fn();
    await renderControls({
      saveTo: vi.fn(),
      onApplyLayout,
      onSaveLayoutAs,
      onManageLayouts,
      onShowTabs,
    });
    await openMoreMenu();
    await act(async () => menuItem("Board.Arrange.ShowTabs")!.click());
    expect(onShowTabs).toHaveBeenCalledOnce();

    // Play board never shows the Layout section.
    await act(async () => {
      jotaiStore.set(tabsAtom, [{ ...tab, type: "play" }], tabId);
    });
    await renderControls({
      disableVariations: true,
      allowEditing: false,
      onApplyLayout,
      onSaveLayoutAs,
      onManageLayouts,
    });
    await openMoreMenu();
    expect(menuItem("Board.Layout.Preset.Repertoire")).toBeNull();
    expect(menuItem("My Study")).toBeNull();
    expect(menuItem("Board.Layout.SaveAs")).toBeNull();
    expect(menuItem("Board.Layout.Manage")).toBeNull();
  });
});
