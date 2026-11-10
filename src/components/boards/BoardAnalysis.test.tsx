import { WorkspaceTabScope } from "@/state/tabScope";
import { act, useContext, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Provider as JotaiProvider, createStore as createJotaiStore, useAtomValue } from "jotai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TreeStateContext, TreeStateProvider } from "@/components/common/TreeStateContext";
import {
  activeTabAtom,
  autoSaveAtom,
  closeWorkspaceTabAtom,
  currentTabAtom,
  tabFamily,
  analysisTabFamily,
  practiceTabFamily,
  reportModalOpenFamily,
  practiceStateFamily,
  tabsAtom,
  updateTabById,
  enginesAtom,
  engineMovesFamily,
  engineTerminalFamily,
  engineRetryFamily,
  threatFamily,
  tabEngineSettingsFamily,
} from "@/state/atoms";
import { displayEngine, displayLines } from "@/tests/engineDisplay";
import { focusedDialogButton, press } from "@/tests/keyboard";
import { analysisSearch } from "../panels/analysis/analysisSearch";
import { AnalysisLineMemory } from "../panels/analysis/analysisLineMemory";
import { engineIdentity, engineLineContext } from "../panels/analysis/analysisLineContext";
import type { Engine } from "@/utils/engines";
import { keyMapAtom } from "@/state/keybinds";
import { getFileFreshness, removeFileFreshness, setFileFreshness } from "@/state/fileFreshness";
import { closeTreeStore, createTreeStore, type TreeStore } from "@/state/store/tree";
import { tabStorage, TabStorageRepository } from "@/state/store/tabStorage";
import { deserializeStorageValue } from "@/state/store/debouncedStorage";
import { WORKSPACE_STORAGE_KEY } from "@/state/workspace";
import type { Tab } from "@/state/workspaceTypes";
import { defaultPGN } from "@/utils/chess";
import { defaultTree } from "@/utils/treeReducer";
import {
  AddGameContext,
  getAddGameLease,
  getTabTreeKey,
  isFileBackedTab,
  replaceFileGame,
  serializeStoreTree,
  saveToFile,
} from "@/utils/tabs";
import { useHotkeys } from "@mantine/hooks";
import { MantineProvider } from "@mantine/core";
import BoardAnalysis from "./BoardAnalysis";
import { normalizeError, type AppError } from "@/platform/errors";
import FileFreshnessGate from "@/components/tabs/FileFreshnessGate";
import i18n, { initializeI18n } from "@/i18n";

const mocks = vi.hoisted(() => ({
  notifyUnlessCancelled: vi.fn(),
  writeGame: vi.fn(),
  countPgnGames: vi.fn(),
  parsePGN: vi.fn(),
  parsePGNWithLossReport: vi.fn(),
  issuePgnWorkspace: vi.fn(),
  issuePgnExportDestination: vi.fn(),
  readGame: vi.fn(),
  writeDbGame: vi.fn(),
  collectionForDatabase: vi.fn(),
  showNotification: vi.fn(),
  translate: (key: string) => key,
  addGameActivation: undefined as (() => void) | undefined,
  realTabs: false,
  compactTabs: false,
  editingMode: false,
}));

vi.mock("@/hooks/useScaledMaxWidth", () => ({ useScaledMaxWidth: () => mocks.compactTabs }));

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: mocks.translate }),
}));

vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.showNotification } }));

vi.mock("@mantine/hooks", () => ({
  useHotkeys: vi.fn(),
  useToggle: () => [mocks.editingMode, vi.fn()],
}));

vi.mock("@mantine/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mantine/core")>();
  const passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Tabs = Object.assign(
    (props: React.ComponentProps<typeof actual.Tabs>) =>
      mocks.realTabs ? <actual.Tabs {...props} /> : passthrough(props),
    {
      List: (props: React.ComponentProps<typeof actual.Tabs.List>) =>
        mocks.realTabs ? <actual.Tabs.List {...props} /> : passthrough(props),
      Panel: (props: React.ComponentProps<typeof actual.Tabs.Panel>) =>
        mocks.realTabs ? <actual.Tabs.Panel {...props} /> : passthrough(props),
      Tab: (props: React.ComponentProps<typeof actual.Tabs.Tab>) =>
        mocks.realTabs ? <actual.Tabs.Tab {...props} /> : passthrough(props),
    },
  );
  return {
    MantineProvider: actual.MantineProvider,
    Paper: passthrough,
    Portal: passthrough,
    Stack: passthrough,
    Tabs,
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button {...props}>{children}</button>
    ),
    Group: passthrough,
    Loader: () => <span>loader</span>,
    Text: passthrough,
  };
});

vi.mock("lucide-react", () => ({
  Database: () => null,
  Info: () => null,
  NotebookPen: () => null,
  Crosshair: () => null,
  ScanSearch: () => null,
}));

vi.mock("@/components/files/notifyError", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/files/notifyError")>()),
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
    tauri: {
      ...actual.tauri,
      countPgnGames: mocks.countPgnGames,
      writeGame: mocks.writeGame,
      issuePgnWorkspace: mocks.issuePgnWorkspace,
      issuePgnExportDestination: mocks.issuePgnExportDestination,
      readGame: mocks.readGame,
      writeDbGame: mocks.writeDbGame,
      collectionForDatabase: mocks.collectionForDatabase,
      reconcileEngineAttachments: vi.fn().mockResolvedValue(undefined),
    },
  };
});

vi.mock("@/utils/chess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/chess")>()),
  parsePGN: mocks.parsePGN,
  parsePGNWithLossReport: mocks.parsePGNWithLossReport,
}));

vi.mock("@/components/tabs/ConfirmChangesModal", () => ({
  default: ({
    opened,
    toggle,
    onSaved,
  }: {
    opened: boolean;
    toggle: () => void;
    onSaved: () => void;
  }) => {
    const saved = useRef(onSaved);
    if (!opened) saved.current = onSaved;
    return opened ? (
      <div role="dialog">
        <button type="button" onClick={toggle}>
          Cancel
        </button>
        <button type="button" onClick={saved.current}>
          Save and add game
        </button>
      </div>
    ) : null;
  },
}));

vi.mock("../panels/info/InfoPanel", () => ({
  default: ({ addGame }: { addGame?: () => void }) => {
    mocks.addGameActivation = addGame;
    return (
      <button type="button" data-testid="add-game" onClick={addGame}>
        Add game
      </button>
    );
  },
}));

vi.mock("../common/DetachedEval", () => ({ default: () => null }));
vi.mock("../common/GameNotation", () => ({ default: () => null }));
vi.mock("../common/MoveControls", () => ({ default: () => null }));
vi.mock("../panels/analysis/AnalysisPanel", () => ({ default: () => null }));
vi.mock("../panels/annotation/AnnotationPanel", () => ({ default: () => null }));
vi.mock("../panels/database/DatabasePanel", () => ({ default: () => null }));
vi.mock("../panels/practice/PracticePanel", () => ({ default: () => null }));
vi.mock("./Board", () => ({ default: () => null }));
vi.mock("./BoardControls", () => ({ default: () => null }));
vi.mock("./EditingCard", () => ({ default: () => null }));
vi.mock("./EvalListener", () => ({ default: () => null }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const hotkeys = vi.mocked(useHotkeys);

function expectNotification(error: AppError) {
  expect(mocks.showNotification).toHaveBeenCalledWith({
    color: "danger",
    title: "Common.Error",
    message: error.message,
  });
  expect(
    mocks.notifyUnlessCancelled.mock.calls.map(([, cause]) => normalizeError(cause)),
  ).toContainEqual(error);
}

// Keep the earlier standalone board witnesses, sourcing their callback from the real gate.
// The composed witnesses below additionally exercise the production withholding boundary.
function CaptureAction({
  action,
}: {
  action: React.RefObject<React.ContextType<typeof AddGameContext>>;
}) {
  action.current = useContext(AddGameContext);
  return null;
}

function RetainedBoardHarness() {
  const tab = useAtomValue(currentTabAtom);
  const action = useRef<React.ContextType<typeof AddGameContext>>(null);
  return (
    <>
      {tab && (
        <FileFreshnessGate tab={tab} closeTab={() => undefined}>
          <CaptureAction action={action} />
        </FileFreshnessGate>
      )}
      <WorkspaceTabScope tabId="11111111-1111-4111-8111-111111111111">
        <AddGameContext.Provider value={(owner) => action.current?.(owner) ?? Promise.resolve()}>
          <BoardAnalysis />
        </AddGameContext.Provider>
      </WorkspaceTabScope>
    </>
  );
}

function ComposedBoardHarness() {
  const tab = useAtomValue(currentTabAtom);
  if (!tab || tab.type !== "analysis") return <div data-testid="away">away</div>;
  return (
    <WorkspaceTabScope tabId={tab.value}>
      <TreeStateProvider key={tab.value} id={tab.value} treeKey={getTabTreeKey(tab)}>
        <FileFreshnessGate tab={tab} closeTab={() => undefined}>
          <BoardAnalysis />
        </FileFreshnessGate>
      </TreeStateProvider>
    </WorkspaceTabScope>
  );
}

describe("BoardAnalysis", () => {
  const tabId = "11111111-1111-4111-8111-111111111111";
  const fileHandle = { id: { id: "workspace-token" }, kind: "fileWorkspace" } as const;
  const tab: Tab = {
    name: "Games",
    value: tabId,
    type: "analysis",
    gameOrigin: {
      kind: "file",
      gameNumber: 1,
      file: {
        type: "file",
        handle: fileHandle,
        name: "games.pgn",
        numGames: 3,
        metadata: { type: "game", tags: [] },
        lastModified: 1,
      },
    },
  };

  let container: HTMLDivElement;
  let root: Root;
  let jotaiStore: ReturnType<typeof createJotaiStore>;
  let treeStore: TreeStore;
  let reset: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mocks.editingMode = false;
    mocks.realTabs = false;
    mocks.compactTabs = false;
    sessionStorage.clear();
    localStorage.clear();
    mocks.notifyUnlessCancelled.mockReset();
    const actualNotify = await vi.importActual<typeof import("@/components/files/notifyError")>(
      "@/components/files/notifyError",
    );
    mocks.notifyUnlessCancelled.mockImplementation(actualNotify.notifyUnlessCancelled);
    mocks.showNotification.mockReset();
    mocks.countPgnGames.mockReset().mockResolvedValue(4);
    mocks.parsePGNWithLossReport.mockReset().mockResolvedValue({ tree: defaultTree(), losses: [] });
    // Save validation reads settle. Gate reconciliation stays pending until cancellation.
    mocks.readGame.mockReset().mockImplementation((_handle, _page, options) =>
      !options?.signal
        ? Promise.resolve({
            pgn: defaultPGN(),
            stamp: treeStore.getState().sourceStamp,
            present: true,
          })
        : new Promise((_resolve, reject) => {
            options?.signal.addEventListener(
              "abort",
              () => reject({ category: "cancellation", message: "Cancellation" }),
              { once: true },
            );
          }),
    );
    mocks.writeGame
      .mockReset()
      .mockResolvedValue({ stamp: "b".repeat(64), revision: "new-revision" });
    mocks.parsePGN.mockReset().mockImplementation(async () => {
      const tree = defaultTree();
      tree.headers.event = "?";
      tree.headers.site = "?";
      tree.headers.date = "????.??.??";
      tree.headers.round = "?";
      tree.headers.white = "?";
      tree.headers.black = "?";
      tree.headers.start = [];
      tree.headers.orientation = "white";
      return tree;
    });
    removeFileFreshness(tabId);
    setFileFreshness(tabId, "verified", { verifiedRevision: "original-revision" });

    jotaiStore = createJotaiStore();
    jotaiStore.set(tabsAtom, [tab], tabId);
    jotaiStore.set(activeTabAtom, tabId);
    jotaiStore.set(autoSaveAtom, false);

    const initialTree = defaultTree();
    initialTree.headers.event = "Keep this tree";
    initialTree.sourceStamp = "a".repeat(64);
    initialTree.dirty = true;
    reset = vi.fn();
    tabStorage.seed(tabId, initialTree);
    treeStore = createTreeStore(tabId);
    reset = vi.spyOn(treeStore.getState(), "reset");

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <JotaiProvider store={jotaiStore}>
          <TreeStateContext.Provider value={treeStore}>
            <RetainedBoardHarness />
          </TreeStateContext.Provider>
        </JotaiProvider>,
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    removeFileFreshness(tabId);
    tabStorage.flush();
    closeTreeStore(tabId);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function modalShortcut(keys: string, key: string, ctrlKey = false) {
    const binding = hotkeys.mock.calls
      .flatMap(([bindings]) => bindings)
      .findLast(([bound]) => bound === keys)!;
    const { getHotkeyHandler } =
      await vi.importActual<typeof import("@mantine/hooks")>("@mantine/hooks");
    const handler = getHotkeyHandler([binding]);
    const { dialog, button } = focusedDialogButton(container);
    expect(document.activeElement).toBe(button);
    document.documentElement.addEventListener("keydown", handler);
    try {
      return press(key, { target: button, ctrlKey });
    } finally {
      document.documentElement.removeEventListener("keydown", handler);
      dialog.remove();
    }
  }

  describe("engine hotkeys", () => {
    function engineLines(engine: Engine = displayEngine, uci = "e2e4", key?: string) {
      const settingsAtom = tabEngineSettingsFamily({ tab: tabId, engineId: engine.id });
      jotaiStore.set(settingsAtom, {
        enabled: true,
        settings: [],
        go: { t: "Infinite" },
        synced: false,
      });
      const context = engineLineContext(jotaiStore.get(settingsAtom), engine);
      const memory = new AnalysisLineMemory();
      memory.context = context;
      const searchedKey = key ?? analysisSearch(treeStore.getState().root.fen, [], false).key!;
      memory.set(searchedKey, [{ ...displayLines[0], uciMoves: [uci] }]);
      jotaiStore.set(engineMovesFamily({ tab: tabId, engine: engine.id }), memory);
      return { memory, settingsAtom, context, searchedKey };
    }

    async function engineKey(
      id: "PLAY_BEST_ENGINE_MOVE" | "TOGGLE_THREAT_MODE",
      prevented = false,
    ) {
      const key = jotaiStore.get(keyMapAtom)[id].keys;
      const binding = hotkeys.mock.calls
        .flatMap(([bindings]) => bindings)
        .findLast(([bound]) => bound === key)!;
      expect(binding[2]?.preventDefault).toBe(false);
      const event = new KeyboardEvent("keydown", { cancelable: true });
      if (prevented) event.preventDefault();
      await act(async () => binding[1](event));
      return event;
    }

    test.each([false, true])(
      "Space adds a variation or navigates an existing child, existing=%s",
      async (existing) => {
        await act(async () => {
          treeStore.getState().makeMove({ payload: "d4" });
          treeStore.getState().goToStart();
          if (existing) {
            treeStore.getState().makeMove({ payload: "e4" });
            treeStore.getState().goToStart();
          }
          await jotaiStore.set(enginesAtom, [displayEngine]);
          engineLines();
        });
        const event = await engineKey("PLAY_BEST_ENGINE_MOVE");
        expect(event.defaultPrevented).toBe(true);
        expect(treeStore.getState().root.children.map((child) => child.san)).toEqual(["d4", "e4"]);
        expect(treeStore.getState().position).toEqual([1]);
        await act(async () => treeStore.getState().goToStart());
        await engineKey("PLAY_BEST_ENGINE_MOVE");
        expect(treeStore.getState().root.children).toHaveLength(2);
      },
    );

    test("Space from a focused blocking dialog leaves the tree and native default unchanged", async () => {
      await act(async () => {
        treeStore.getState().makeMove({ payload: "d4" });
        treeStore.getState().goToStart();
        treeStore.setState({ dirty: false });
        await jotaiStore.set(enginesAtom, [displayEngine]);
        engineLines();
      });
      const before = treeStore.getState();

      const event = await modalShortcut(jotaiStore.get(keyMapAtom).PLAY_BEST_ENGINE_MOVE.keys, " ");

      expect(treeStore.getState().root).toBe(before.root);
      expect(treeStore.getState().position).toEqual(before.position);
      expect(treeStore.getState().dirty).toBe(false);
      expect(event.defaultPrevented).toBe(false);
      await engineKey("PLAY_BEST_ENGINE_MOVE");
      expect(treeStore.getState().root.children.map((child) => child.san)).toEqual(["d4", "e4"]);
    });

    test.each([
      "stale-key",
      "context",
      "failed",
      "disabled",
      "unloaded",
      "threat",
      "practice",
      "editing",
      "illegal",
      "prevented",
      "no-lines",
      "no-context",
    ] as const)("Space leaves the tree and native event alone for %s", async (reason) => {
      await act(async () => {
        await jotaiStore.set(enginesAtom, [{ ...displayEngine, loaded: reason !== "unloaded" }]);
        const setup = engineLines(
          displayEngine,
          reason === "illegal" ? "e2e5" : "e2e4",
          reason === "stale-key" ? "old-position" : undefined,
        );
        if (reason === "context") setup.memory.context = "old settings";
        if (reason === "no-context") setup.memory.context = null;
        if (reason === "no-lines") setup.memory.clear();
        if (reason === "disabled")
          jotaiStore.set(setup.settingsAtom, (s) => ({ ...s, enabled: false }));
        if (reason === "failed")
          jotaiStore.set(engineTerminalFamily({ tab: tabId, engine: displayEngine.id }), {
            type: "failed",
            context: setup.context,
            searchedKey: setup.searchedKey,
            retry: 0,
            fingerprint: "attempt",
            generation: "generation",
            engineIdentity: engineIdentity(displayEngine),
          });
        if (reason === "threat") jotaiStore.set(threatFamily(tabId), true);
        if (reason === "practice") {
          jotaiStore.set(tabFamily(tabId), "practice");
          jotaiStore.set(practiceTabFamily(tabId), "train");
        }
        if (reason === "editing") {
          mocks.editingMode = true;
          root.render(
            <JotaiProvider store={jotaiStore}>
              <TreeStateContext.Provider value={treeStore}>
                <RetainedBoardHarness />
              </TreeStateContext.Provider>
            </JotaiProvider>,
          );
        }
      });
      const before = treeStore.getState();
      const event = await engineKey("PLAY_BEST_ENGINE_MOVE", reason === "prevented");
      expect(treeStore.getState()).toBe(before);
      expect(event.defaultPrevented).toBe(reason === "prevented");
    });

    test.each([false, true])(
      "Space chooses the first eligible engine in tab order with duplicate names and paths, first disabled=%s",
      async (disabled) => {
        const other = { ...displayEngine, id: "second-engine" };
        await act(async () => {
          await jotaiStore.set(enginesAtom, [displayEngine, other]);
          const first = engineLines();
          engineLines(other, "d2d4");
          if (disabled) jotaiStore.set(first.settingsAtom, (s) => ({ ...s, enabled: false }));
        });
        await engineKey("PLAY_BEST_ENGINE_MOVE");
        expect(treeStore.getState().currentNode().san).toBe(disabled ? "d4" : "e4");
      },
    );

    test("Space leaves the tree and native event alone when the only current line is PV2", async () => {
      await act(async () => {
        await jotaiStore.set(enginesAtom, [displayEngine]);
        const { memory, searchedKey } = engineLines();
        memory.set(searchedKey, [{ ...displayLines[0], multipv: 2, uciMoves: ["e2e4"] }]);
      });
      const before = treeStore.getState();
      const event = await engineKey("PLAY_BEST_ENGINE_MOVE");
      expect(treeStore.getState()).toBe(before);
      expect(event.defaultPrevented).toBe(false);
    });

    test("a failed terminal only blocks its matching retry and search key", async () => {
      await act(async () => {
        await jotaiStore.set(enginesAtom, [displayEngine]);
        const setup = engineLines();
        jotaiStore.set(engineTerminalFamily({ tab: tabId, engine: displayEngine.id }), {
          type: "failed",
          context: setup.context,
          searchedKey: setup.searchedKey,
          retry: 0,
          fingerprint: "attempt",
          generation: "generation",
          engineIdentity: engineIdentity(displayEngine),
        });
        jotaiStore.set(engineRetryFamily({ tab: tabId, engine: displayEngine.id }), 1);
      });
      await engineKey("PLAY_BEST_ENGINE_MOVE");
      expect(treeStore.getState().currentNode().san).toBe("e4");
    });

    test("X leaves threat off and the native event alone when the only enabled engine is unloaded", async () => {
      const engine = { ...displayEngine, loaded: false };
      await act(async () => {
        await jotaiStore.set(enginesAtom, [engine]);
        engineLines(engine);
      });
      const event = await engineKey("TOGGLE_THREAT_MODE");
      expect.soft(jotaiStore.get(threatFamily(tabId))).toBe(false);
      expect.soft(event.defaultPrevented).toBe(false);

      await act(async () => jotaiStore.set(threatFamily(tabId), true));
      expect((await engineKey("TOGGLE_THREAT_MODE")).defaultPrevented).toBe(true);
      expect(jotaiStore.get(threatFamily(tabId))).toBe(false);
    });

    test("X requires a loaded enabled engine to turn on and always permits turning off", async () => {
      expect((await engineKey("TOGGLE_THREAT_MODE")).defaultPrevented).toBe(false);
      await act(async () => {
        await jotaiStore.set(enginesAtom, [displayEngine]);
        engineLines();
      });
      expect((await engineKey("TOGGLE_THREAT_MODE")).defaultPrevented).toBe(true);
      expect(jotaiStore.get(threatFamily(tabId))).toBe(true);
      await act(async () => jotaiStore.set(enginesAtom, []));
      await engineKey("TOGGLE_THREAT_MODE");
      expect(jotaiStore.get(threatFamily(tabId))).toBe(false);
      await act(async () => {
        await jotaiStore.set(enginesAtom, [displayEngine]);
        jotaiStore.set(
          tabEngineSettingsFamily({ tab: tabId, engineId: displayEngine.id }),
          (s) => ({
            ...s,
            enabled: false,
          }),
        );
      });
      await engineKey("TOGGLE_THREAT_MODE");
      expect(jotaiStore.get(threatFamily(tabId))).toBe(false);
    });
  });

  test("annotation shortcut ignores a key from a focused blocking dialog button", async () => {
    await act(async () => treeStore.setState({ root: defaultTree().root, dirty: false }));
    const key = jotaiStore.get(keyMapAtom).ANNOTATION_BRILLIANT.keys;
    const binding = hotkeys.mock.calls
      .flatMap(([bindings]) => bindings)
      .findLast(([bound]) => bound === key)!;
    const before = treeStore.getState();

    const event = await modalShortcut(key, "1");

    expect(treeStore.getState().root).toBe(before.root);
    expect(treeStore.getState().root.nags).toEqual([]);
    expect(treeStore.getState().dirty).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    await act(async () => binding[1](new KeyboardEvent("keydown", { key })));
    expect(treeStore.getState().root.nags).toEqual([3]);
    expect(treeStore.getState().dirty).toBe(true);
  });

  test("Clear Shapes from a focused blocking dialog preserves shapes and the native default", async () => {
    const shapes = [{ orig: "a1", dest: "a3", brush: "green" }] as const;
    await act(async () => {
      treeStore.getState().setShapes([...shapes]);
      treeStore.setState({ dirty: false });
    });
    const before = treeStore.getState();

    const event = await modalShortcut(jotaiStore.get(keyMapAtom).CLEAR_SHAPES.keys, "l", true);

    expect(treeStore.getState().root).toBe(before.root);
    expect(treeStore.getState().currentNode().shapes).toEqual(shapes);
    expect(treeStore.getState().dirty).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  test("annotation shortcuts preserve all six glyphs and block every active practice phase", async () => {
    const keyMap = jotaiStore.get(keyMapAtom);
    const annotations = [
      [keyMap.ANNOTATION_BRILLIANT.keys, 3],
      [keyMap.ANNOTATION_GOOD.keys, 1],
      [keyMap.ANNOTATION_INTERESTING.keys, 5],
      [keyMap.ANNOTATION_DUBIOUS.keys, 6],
      [keyMap.ANNOTATION_MISTAKE.keys, 2],
      [keyMap.ANNOTATION_BLUNDER.keys, 4],
    ] as const;
    for (const [panel, phase, blocked] of [
      ["info", "idle", false],
      ["practice", "correct", true],
      ["practice", "waiting", true],
      ["practice", "replaying", true],
      ["practice", "learning", true],
      ["practice", "retry", true],
      ["practice", "revealed", true],
      ["practice", "advancing", true],
      ["practice", "idle", false],
      ["info", "correct", false],
    ] as const) {
      await act(async () => {
        jotaiStore.set(tabFamily(tabId), panel);
        jotaiStore.set(practiceTabFamily(tabId), "train");
        jotaiStore.set(practiceStateFamily(tabId), { phase });
      });
      for (const [keys, nag] of annotations) {
        await act(async () => treeStore.setState({ root: defaultTree().root, dirty: false }));
        const binding = hotkeys.mock.calls
          .flatMap(([bindings]) => bindings)
          .findLast(([bound]) => bound === keys);
        expect(binding).toBeDefined();
        await act(async () => binding![1](new KeyboardEvent("keydown")));
        expect(treeStore.getState().root.nags).toEqual(blocked ? [] : [nag]);
        expect(treeStore.getState().dirty).toBe(!blocked);
      }
    }
  });

  test.each([false, true])(
    "real board tabs preserve heading order, panel layout, unmounting and special shortcuts, compact=%s",
    async (compact) => {
      mocks.realTabs = true;
      mocks.compactTabs = compact;
      vi.stubGlobal(
        "matchMedia",
        vi.fn(() => ({
          matches: false,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        })),
      );
      await act(async () => {
        jotaiStore.set(tabFamily(tabId), "info");
        root.render(
          <MantineProvider>
            <JotaiProvider store={jotaiStore}>
              <TreeStateContext.Provider value={treeStore}>
                <RetainedBoardHarness />
              </TreeStateContext.Provider>
            </JotaiProvider>
          </MantineProvider>,
        );
      });
      const headings = () =>
        Array.from(container.querySelectorAll('[role="tab"]')).map(
          (heading) => heading.textContent,
        );
      expect(headings()).toEqual([
        "Board.Tabs.Analysis",
        "Board.Tabs.Database",
        "Board.Tabs.Annotate",
        "Board.Tabs.Info",
      ]);
      const shortcut = async (keys: string) => {
        const binding = hotkeys.mock.calls
          .flatMap(([bindings]) => bindings)
          .findLast(([bound]) => bound === keys);
        expect(binding).toBeDefined();
        const event = new KeyboardEvent("keydown", { cancelable: true });
        await act(async () => binding![1](event));
        return event;
      };
      const keys = jotaiStore.get(keyMapAtom);
      await shortcut(keys.PRACTICE_TAB.keys);
      expect(jotaiStore.get(tabFamily(tabId))).toBe("info");
      for (const [binding, panel] of [
        [keys.ANALYSIS_TAB.keys, "analysis"],
        [keys.DATABASE_TAB.keys, "database"],
        [keys.ANNOTATE_TAB.keys, "annotate"],
        [keys.INFO_TAB.keys, "info"],
      ] as const) {
        await shortcut(binding);
        expect(jotaiStore.get(tabFamily(tabId))).toBe(panel);
        expect(container.querySelector('[data-testid="add-game"]') !== null).toBe(panel === "info");
        for (const element of container.querySelectorAll<HTMLElement>('[role="tabpanel"]')) {
          expect(element.style.flex).toBe("1 1 0%");
          expect(element.style.overflowY).toBe("hidden");
        }
      }
      const reportEvent = await shortcut(keys.GENERATE_REPORT.keys);
      expect(reportEvent.defaultPrevented).toBe(true);
      expect(jotaiStore.get(tabFamily(tabId))).toBe("analysis");
      expect(jotaiStore.get(analysisTabFamily(tabId))).toBe("report");
      expect(jotaiStore.get(reportModalOpenFamily(tabId))).toBe(true);
      if (!isFileBackedTab(tab)) throw new Error("Expected file owner");
      await act(async () =>
        jotaiStore.set(
          tabsAtom,
          [
            {
              ...tab,
              gameOrigin: {
                ...tab.gameOrigin,
                file: {
                  ...tab.gameOrigin.file,
                  metadata: { type: "repertoire", tags: [] },
                },
              },
            },
          ],
          tabId,
        ),
      );
      expect(headings()).toEqual([
        "Board.Tabs.Practice",
        "Board.Tabs.Analysis",
        "Board.Tabs.Database",
        "Board.Tabs.Annotate",
        "Board.Tabs.Info",
      ]);
      await shortcut(keys.PRACTICE_TAB.keys);
      expect(jotaiStore.get(tabFamily(tabId))).toBe("practice");
      expect(container.querySelectorAll('[role="tabpanel"]')).toHaveLength(5);
      expect(jotaiStore.get(analysisTabFamily(tabId))).toBe("report");
      expect(jotaiStore.get(reportModalOpenFamily(tabId))).toBe(true);
    },
  );

  test("dirty Add Game asks first and Cancel keeps the edited tree without writing", async () => {
    const treeBefore = structuredClone(treeStore.getState().root);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="add-game"]')!.click();
    });

    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toEqual(tab.gameOrigin);
    expect(jotaiStore.get(tabsAtom)).toHaveLength(1);
    expect(treeStore.getState().root).toEqual(treeBefore);
    expect(reset).not.toHaveBeenCalled();
    expect(mocks.writeGame).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("Save and add game");

    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Cancel")!
        .click();
    });

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(treeStore.getState().root).toEqual(treeBefore);
    expect(treeStore.getState().dirty).toBe(true);
    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toEqual(tab.gameOrigin);
    expect(mocks.writeGame).not.toHaveBeenCalled();
  });

  test("Add Game withholds the board during append and moves the origin only after success", async () => {
    let resolveWrite: (value: { stamp: string | null; revision: string | null }) => void = () =>
      undefined;
    mocks.writeGame.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveWrite = resolve;
      }),
    );

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="add-game"]')!.click();
    });
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Save and add game")!
        .click();
    });

    expect(mocks.writeGame).toHaveBeenCalledWith(fileHandle, 3, defaultPGN(), { kind: "append" });
    expect(mocks.parsePGN).toHaveBeenCalledWith(defaultPGN());
    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toEqual(tab.gameOrigin);
    expect(reset).not.toHaveBeenCalled();
    expect(getFileFreshness(tabId).state).toBe("appending");

    await act(async () => resolveWrite({ stamp: "b".repeat(64), revision: "new-revision" }));

    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({
      kind: "file",
      gameNumber: 3,
      file: { numGames: 4 },
    });
    expect(reset).not.toHaveBeenCalled();
    expect(treeStore.getState()).toMatchObject({
      sourceStamp: "b".repeat(64),
      dirty: false,
      headers: { event: "?" },
    });
    expect(getFileFreshness(tabId)).toMatchObject({
      state: "verified",
      verifiedRevision: "new-revision",
    });
  });

  test("Add Game stops when Save-As changed the captured temp-file origin", async () => {
    const source = tab.gameOrigin;
    if (source.kind !== "file") throw new Error("expected file-backed test tab");
    const tempTab: Tab = {
      ...tab,
      gameOrigin: { kind: "temp_file", file: source.file, gameNumber: source.gameNumber },
    };
    const destinationTab: Tab = {
      ...tempTab,
      gameOrigin: {
        kind: "file",
        file: {
          ...source.file,
          handle: { id: { id: "save-as-destination" }, kind: "fileWorkspace" },
        },
        gameNumber: source.gameNumber,
      },
    };
    await act(async () => jotaiStore.set(tabsAtom, [tempTab], tabId));

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="add-game"]')!.click();
    });
    await act(async () => {
      jotaiStore.set(tabsAtom, [destinationTab], tabId);
      setFileFreshness(tabId, "verified", { verifiedRevision: "save-as-revision" });
    });
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Save and add game")!
        .click();
    });

    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toEqual(destinationTab.gameOrigin);
    expect(mocks.parsePGN).not.toHaveBeenCalled();
    expect(mocks.writeGame).not.toHaveBeenCalled();
    expect(mocks.countPgnGames).not.toHaveBeenCalled();
    expect(getFileFreshness(tabId)).toMatchObject({
      state: "verified",
      verifiedRevision: "save-as-revision",
    });
  });

  test.each(["removed", "non-file", "page"] as const)(
    "Add Game refuses a %s owner after parsing before the native append",
    async (change) => {
      if (tab.gameOrigin.kind !== "file") throw new Error("expected file-backed test tab");
      let resolveParse!: (tree: ReturnType<typeof defaultTree>) => void;
      mocks.parsePGN.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveParse = resolve;
        }),
      );
      await act(async () => treeStore.setState({ dirty: false }));
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="add-game"]')!.click();
      });
      expect(mocks.parsePGN).toHaveBeenCalledOnce();
      const next: Tab = {
        ...tab,
        value: change === "removed" ? "22222222-2222-4222-8222-222222222222" : tabId,
        gameOrigin: change === "non-file" ? { kind: "none" } : { ...tab.gameOrigin, gameNumber: 2 },
      };
      await act(async () => {
        jotaiStore.set(tabsAtom, [next], next.value);
        resolveParse(defaultTree());
      });
      expect(mocks.writeGame).not.toHaveBeenCalled();
      expect(mocks.countPgnGames).not.toHaveBeenCalled();
      expect(treeStore.getState().headers.event).toBe("Keep this tree");
    },
  );

  test.each(["removed", "non-file", "page"] as const)(
    "Add Game preserves the live tree when its %s owner supersedes the pending append",
    async (change) => {
      if (tab.gameOrigin.kind !== "file") throw new Error("expected file-backed test tab");
      let resolveWrite!: (written: { stamp: string; revision: string }) => void;
      mocks.writeGame.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveWrite = resolve;
        }),
      );
      await act(async () => treeStore.setState({ dirty: false }));
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="add-game"]')!.click();
      });
      expect(mocks.writeGame).toHaveBeenCalledOnce();
      const next: Tab = {
        ...tab,
        value: change === "removed" ? "22222222-2222-4222-8222-222222222222" : tabId,
        gameOrigin: change === "non-file" ? { kind: "none" } : { ...tab.gameOrigin, gameNumber: 2 },
      };
      await act(async () => {
        jotaiStore.set(tabsAtom, [next], next.value);
        resolveWrite({ stamp: "b".repeat(64), revision: "appended" });
      });
      expect(jotaiStore.get(tabsAtom)).toEqual([next]);
      expect(treeStore.getState().headers.event).toBe("Keep this tree");
      expect(treeStore.getState().sourceStamp).toBe("a".repeat(64));
    },
  );

  test("Add Game refreshes a stale count and retries at the new end", async () => {
    mocks.writeGame.mockRejectedValueOnce({
      tag: "backend-error",
      category: "stale-game",
      message: "The game changed on disk",
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="add-game"]')!.click();
    });
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Save and add game")!
        .click();
    });

    expect(mocks.countPgnGames).toHaveBeenCalledWith(fileHandle);
    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({
      kind: "file",
      gameNumber: 1,
      file: { numGames: 4 },
    });
    expectNotification({
      category: "validation",
      message: "FileFreshness.AddGameChanged",
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="add-game"]')!.click();
    });
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Save and add game")!
        .click();
    });

    expect(mocks.writeGame).toHaveBeenNthCalledWith(2, fileHandle, 4, defaultPGN(), {
      kind: "append",
    });
    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({
      kind: "file",
      gameNumber: 4,
      file: { numGames: 5 },
    });
    expect(getFileFreshness(tabId)).toMatchObject({
      state: "verified",
      verifiedRevision: "new-revision",
    });
    expect(treeStore.getState()).toMatchObject({
      sourceStamp: "b".repeat(64),
      dirty: false,
      headers: { event: "?" },
    });
  });

  test("a null append stamp keeps the old origin and refreshes its game count", async () => {
    mocks.writeGame.mockResolvedValueOnce({ stamp: null, revision: null });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="add-game"]')!.click();
    });
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Save and add game")!
        .click();
    });

    expect(mocks.countPgnGames).toHaveBeenCalledWith(fileHandle);
    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({
      kind: "file",
      gameNumber: 1,
      file: { numGames: 4 },
    });
    expectNotification({
      category: "applied-despite-error",
      message: "FileFreshness.AddGameMayHaveBeenAdded",
    });
    expect(getFileFreshness(tabId).state).toBe("unverified");
  });

  test("a null append stamp reports a failed game-count refresh", async () => {
    mocks.writeGame.mockResolvedValueOnce({ stamp: null, revision: null });
    mocks.countPgnGames.mockRejectedValueOnce({
      tag: "backend-error",
      category: "io",
      message: "Could not refresh the PGN game count",
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="add-game"]')!.click();
    });
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Save and add game")!
        .click();
    });

    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({
      kind: "file",
      gameNumber: 1,
      file: { numGames: 3 },
    });
    expectNotification({
      category: "unexpected",
      backendCategory: "io",
      message: "Could not refresh the PGN game count",
    });
    expectNotification({
      category: "applied-despite-error",
      message: "FileFreshness.AddGameMayHaveBeenAdded",
    });
  });

  test("a failed count refresh after StaleGame reports that typed error without changing count", async () => {
    mocks.writeGame.mockRejectedValueOnce({
      tag: "backend-error",
      category: "stale-game",
      message: "The game changed on disk",
    });
    mocks.countPgnGames.mockRejectedValueOnce({
      tag: "backend-error",
      category: "io",
      message: "Could not refresh the PGN game count",
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="add-game"]')!.click();
    });
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Save and add game")!
        .click();
    });

    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({
      kind: "file",
      gameNumber: 1,
      file: { numGames: 3 },
    });
    expectNotification({
      category: "unexpected",
      backendCategory: "io",
      message: "Could not refresh the PGN game count",
    });
    expect(mocks.showNotification).not.toHaveBeenCalledWith({
      color: "danger",
      title: "Common.Error",
      message: "FileFreshness.AddGameChanged",
    });
  });

  test("uncertain Add Game reports that it may have been added without moving origin", async () => {
    mocks.writeGame.mockRejectedValueOnce(new Error("durability uncertain"));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="add-game"]')!.click();
    });
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Save and add game")!
        .click();
    });

    expect(jotaiStore.get(currentTabAtom)?.gameOrigin).toMatchObject({
      kind: "file",
      gameNumber: tab.gameOrigin.kind === "file" ? tab.gameOrigin.gameNumber : -1,
      file: { numGames: 4 },
    });
    expectNotification({
      category: "unexpected",
      message: "FileFreshness.AddGameMayHaveBeenAdded durability uncertain",
    });
  });

  function latestSaveHotkey(): () => void {
    const keys = jotaiStore.get(keyMapAtom).SAVE_FILE.keys;
    const hotkeys = vi.mocked(useHotkeys);
    const binding = hotkeys.mock.calls
      .flatMap(([bindings]) => bindings)
      .findLast(([bound]) => bound === keys);
    if (!binding) throw new Error("BoardAnalysis registered no Save hotkey");
    return () => binding[1](new KeyboardEvent("keydown"));
  }

  test("a database orientation flip autosaves its PGN tag and advances the row stamp", async () => {
    const database = { id: { id: "orientation-db" }, kind: "database" } as const;
    mocks.collectionForDatabase.mockReset().mockResolvedValue(null);
    mocks.writeDbGame.mockReset().mockResolvedValue("b".repeat(64));
    await act(async () => {
      treeStore.getState().setState({ ...defaultTree(), sourceStamp: "a".repeat(64) });
      updateTabById(
        (...args) => jotaiStore.set(tabsAtom, ...args),
        tabId,
        (previous) => ({
          ...previous,
          gameOrigin: { kind: "database", database, gameId: 812 },
        }),
      );
      jotaiStore.set(autoSaveAtom, true);
    });
    expect(mocks.writeDbGame).not.toHaveBeenCalled();
    await act(async () => {
      treeStore.getState().setHeaders({
        ...treeStore.getState().headers,
        fen: treeStore.getState().root.fen,
        orientation: "black",
      });
    });
    await vi.waitFor(() => expect(mocks.writeDbGame).toHaveBeenCalledOnce());
    expect(mocks.writeDbGame).toHaveBeenCalledWith(
      database,
      812,
      expect.stringContaining('[Orientation "black"]'),
      "a".repeat(64),
    );
    expect(treeStore.getState()).toMatchObject({ dirty: false, sourceStamp: "b".repeat(64) });
    expect(mocks.writeGame).not.toHaveBeenCalled();
  });

  async function startAutosave() {
    const tree = defaultTree();
    tree.headers.event = "Captured autosave header";
    tree.root.comment = "Captured autosave comment";
    tree.sourceStamp = "a".repeat(64);
    tree.dirty = true;
    treeStore = createTreeStore(undefined, tree);
    await act(async () => {
      root.render(
        <JotaiProvider store={jotaiStore}>
          <TreeStateContext.Provider value={treeStore}>
            <WorkspaceTabScope tabId={tabId}>
              <BoardAnalysis />
            </WorkspaceTabScope>
          </TreeStateContext.Provider>
        </JotaiProvider>,
      );
      jotaiStore.set(autoSaveAtom, true);
    });
  }

  test.each(["io", "resource-limit", "cancellation"] as const)(
    "production autosave presents current-owner %s failures and preserves newer dirty edits",
    async (category) => {
      let rejectWrite!: (reason: unknown) => void;
      mocks.writeGame.mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectWrite = reject;
        }),
      );
      await startAutosave();
      const captured = serializeStoreTree(treeStore);
      expect(mocks.writeGame).toHaveBeenCalledOnce();
      expect(mocks.writeGame).toHaveBeenCalledWith(fileHandle, 1, captured, {
        kind: "game",
        stamp: "a".repeat(64),
      });
      expect(captured).toContain("Captured autosave comment");
      expect(captured).toContain("Captured autosave header");
      await act(async () => {
        treeStore.getState().setComment("Newer autosave comment");
        treeStore
          .getState()
          .setHeaders({ ...treeStore.getState().headers, event: "Newer autosave header" });
        rejectWrite({
          tag: "backend-error",
          category,
          message: category === "cancellation" ? "Cancellation" : "Autosave failed",
        });
      });
      expect(treeStore.getState().dirty).toBe(true);
      expect(serializeStoreTree(treeStore)).toContain("Newer autosave comment");
      expect(serializeStoreTree(treeStore)).toContain("Newer autosave header");
      expect(mocks.showNotification).toHaveBeenCalledTimes(category === "cancellation" ? 0 : 1);
      expect(mocks.showNotification.mock.calls).toEqual(
        category === "cancellation"
          ? []
          : [
              [
                {
                  color: "danger",
                  title: "Common.Error",
                  message: "Autosave failed",
                },
              ],
            ],
      );
      expect(mocks.writeGame).toHaveBeenCalledOnce();
    },
  );

  test.each(["failure", "success"] as const)(
    "production autosave remains silent after its physical owner is superseded before %s",
    async (outcome) => {
      let resolveWrite!: (written: { stamp: string; revision: string }) => void;
      let rejectWrite!: (reason: unknown) => void;
      mocks.writeGame.mockReturnValueOnce(
        new Promise((resolve, reject) => {
          resolveWrite = resolve;
          rejectWrite = reject;
        }),
      );
      await startAutosave();
      expect(mocks.writeGame).toHaveBeenCalledOnce();
      await act(async () => {
        jotaiStore.set(autoSaveAtom, false);
        jotaiStore.set(tabsAtom, [{ ...tab, treeKey: crypto.randomUUID() }], tabId);
        treeStore.getState().setComment("Newer owner comment");
        treeStore
          .getState()
          .setHeaders({ ...treeStore.getState().headers, event: "Newer owner header" });
        if (outcome === "failure")
          rejectWrite({
            tag: "backend-error",
            category: "io",
            message: "Obsolete autosave failed",
          });
        else resolveWrite({ stamp: "b".repeat(64), revision: "obsolete" });
      });
      expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
      expect(mocks.showNotification).not.toHaveBeenCalled();
      expect(treeStore.getState().dirty).toBe(true);
      expect(treeStore.getState().sourceStamp).toBe("a".repeat(64));
      expect(serializeStoreTree(treeStore)).toContain("Newer owner comment");
      expect(serializeStoreTree(treeStore)).toContain("Newer owner header");
      expect(mocks.writeGame).toHaveBeenCalledOnce();
    },
  );

  test("a Save conflict on a file-backed tab leaves the notice to the freshness panel", async () => {
    mocks.writeGame.mockResolvedValueOnce({ stamp: null, revision: null });

    await act(async () => {
      latestSaveHotkey()();
      await vi.waitFor(() => expect(getFileFreshness(tabId).state).toBe("unverified"));
    });

    expect(jotaiStore.get(tabsAtom)[0]?.gameOrigin.kind).toBe("file");
    expect(mocks.showNotification).not.toHaveBeenCalledWith({
      color: "danger",
      title: "Common.Error",
      message: "Tab.SaveMayHaveBeenWritten",
    });
  });

  test("a refused database user save preserves dirty edits without the uncertain-write toast", async () => {
    mocks.collectionForDatabase.mockReset().mockResolvedValue(null);
    mocks.writeDbGame.mockReset().mockRejectedValueOnce({
      tag: "backend-error",
      category: "stale-game",
      message: "stale game",
    });
    await act(async () => {
      updateTabById(
        (...args) => jotaiStore.set(tabsAtom, ...args),
        tabId,
        (previous) => ({
          ...previous,
          gameOrigin: {
            kind: "database",
            database: { id: { id: "cas-database" }, kind: "database" },
            gameId: 812,
          },
        }),
      );
    });
    await act(async () => {
      latestSaveHotkey()();
      await vi.waitFor(() => expect(getFileFreshness(tabId).state).toBe("conflict"));
    });
    expect(mocks.writeDbGame).toHaveBeenCalledOnce();
    expect(treeStore.getState().dirty).toBe(true);
    expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
    expect(mocks.showNotification).not.toHaveBeenCalled();
  });

  test("a fresh toolbar save with uncertain readback preserves dirty edits and durably refuses another append", async () => {
    await initializeI18n();
    const destination = { id: { id: "picked-token" }, kind: "fileWorkspace" } as const;
    mocks.issuePgnExportDestination.mockResolvedValueOnce({
      handle: destination,
      displayName: "picked.pgn",
    });
    mocks.countPgnGames.mockResolvedValueOnce(4);
    mocks.writeGame.mockResolvedValueOnce({ stamp: null, revision: null });
    await act(async () => {
      jotaiStore.set(tabsAtom, [{ ...tab, gameOrigin: { kind: "none" } }], tabId);
      treeStore.getState().setSourceStamp(null);
      treeStore.getState().setComment("Fresh unsaved toolbar comment");
    });
    const pgn = serializeStoreTree(treeStore);
    await act(async () => {
      latestSaveHotkey()();
      await vi.waitFor(() => expect(mocks.showNotification).toHaveBeenCalled());
    });

    expect(mocks.issuePgnExportDestination).toHaveBeenCalledOnce();
    expect(mocks.issuePgnWorkspace).not.toHaveBeenCalled();
    expect(mocks.countPgnGames).toHaveBeenCalledWith(destination);
    expect(mocks.readGame).not.toHaveBeenCalled();
    expect(mocks.writeGame).toHaveBeenCalledWith(destination, 4, pgn, {
      kind: "append",
    });
    expectNotification({
      category: "applied-despite-error",
      message: i18n.t("FileFreshness.AppendMayHaveBeenAdded"),
    });
    expect(jotaiStore.get(tabsAtom)[0]?.gameOrigin).toEqual({ kind: "none" });
    expect(treeStore.getState()).toMatchObject({
      dirty: true,
      sourceStamp: null,
      appendAttempted: true,
    });
    expect(serializeStoreTree(treeStore)).toBe(pgn);
    expect(tabStorage.flush()).toEqual([]);
    expect(new TabStorageRepository().read(getTabTreeKey(tab))?.state).toMatchObject({
      dirty: true,
      appendAttempted: true,
    });
    await act(async () => latestSaveHotkey()());
    expect(mocks.writeGame).toHaveBeenCalledOnce();
    expect(mocks.issuePgnExportDestination).toHaveBeenCalledOnce();
    expect(serializeStoreTree(treeStore)).toBe(pgn);
  });

  const awayTab: Tab = {
    name: "Away",
    value: "22222222-2222-4222-8222-222222222222",
    type: "new",
    gameOrigin: { kind: "none" },
  };
  type Written = { stamp: string | null; revision: string | null };
  function held<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  }
  async function composed() {
    await act(async () => {
      treeStore.setState({ dirty: false });
      jotaiStore.set(tabsAtom, [tab, awayTab], tabId);
      root.render(
        <JotaiProvider store={jotaiStore}>
          <ComposedBoardHarness />
        </JotaiProvider>,
      );
    });
    expect(createTreeStore(tabId)).toBe(treeStore);
    expect(container.querySelector('[data-testid="add-game"]')).not.toBeNull();
  }
  async function activate() {
    await act(async () => {
      const button = container.querySelector<HTMLButtonElement>('[data-testid="add-game"]');
      if (button) button.click();
      else mocks.addGameActivation?.();
    });
  }
  async function navigate(id: string) {
    await act(async () => {
      expect(jotaiStore.set(activeTabAtom, id)).toBe(true);
    });
    expect(container.querySelector("[data-file-freshness]") !== null).toBe(id !== awayTab.value);
    expect(container.querySelector('[data-testid="away"]') !== null).toBe(id === awayTab.value);
  }
  function expectPending() {
    expect(container.querySelector('[data-testid="add-game"]')).toBeNull();
    expect(container.textContent).toContain("FileFreshness.AddingGame");
    expect(container.querySelector('[data-file-freshness^="appending:"]')).not.toBeNull();
  }
  function expectCompleted() {
    expect(jotaiStore.get(tabsAtom)[0]?.gameOrigin).toMatchObject({
      kind: "file",
      gameNumber: 3,
      file: { numGames: 4 },
    });
    expect(treeStore.getState()).toMatchObject({
      dirty: false,
      sourceStamp: "b".repeat(64),
      headers: { event: "?" },
      root: { children: [], comment: "" },
    });
    expect(getFileFreshness(tabId)).toMatchObject({ state: "verified", verifiedRevision: "added" });
    expect(
      new TabStorageRepository().read(getTabTreeKey(jotaiStore.get(tabsAtom)[0]!))?.state,
    ).toMatchObject({ sourceStamp: "b".repeat(64), headers: { event: "?" } });
  }
  function startOrdinarySave() {
    return saveToFile({
      tab: jotaiStore.get(currentTabAtom),
      store: treeStore,
      getTab: (id) => jotaiStore.get(tabsAtom).find((owner) => owner.value === id),
      updateTab: (id, update) =>
        updateTabById((next) => jotaiStore.set(tabsAtom, next), id, update),
      isUserSave: true,
    });
  }
  async function replaceOwner() {
    const owner = jotaiStore.get(tabsAtom)[0]!;
    if (!isFileBackedTab(owner)) throw new Error("Expected file owner");
    const candidate = defaultTree();
    candidate.headers.event = "Replacement event";
    candidate.root.comment = "Replacement comment";
    candidate.sourceStamp = "c".repeat(64);
    await act(async () => {
      const replacement = replaceFileGame({
        store: jotaiStore,
        owner,
        treeStore,
        snapshot: treeStore.getState(),
        tree: candidate,
        page: 1,
        isCurrent: () => true,
      });
      expect(replacement.kind).toBe("committed");
      setFileFreshness(tabId, "verified", {
        verifiedRevision: "replacement",
        errorMessage: "replacement diagnostic",
      });
      expect(
        jotaiStore.set(tabsAtom, (owners) =>
          owners.map((live) =>
            live.value === tabId ? { ...live, name: "Replacement metadata" } : live,
          ),
        ),
      ).toBe(true);
    });
    const live = jotaiStore.get(tabsAtom)[0]!;
    expect(live.value).toBe(owner.value);
    expect(live.gameOrigin).toEqual(owner.gameOrigin);
    expect(getTabTreeKey(live)).not.toBe(getTabTreeKey(owner));
    expect(createTreeStore(tabId)).toBe(treeStore);
    expect(tabStorage.flush()).toEqual([]);
    return {
      state: treeStore.getState(),
      freshness: getFileFreshness(tabId),
      tabs: jotaiStore.get(tabsAtom),
      bytes: sessionStorage.getItem(getTabTreeKey(live)),
      workspace: sessionStorage.getItem(WORKSPACE_STORAGE_KEY),
      key: getTabTreeKey(live),
    };
  }
  function expectReplacement(replacement: Awaited<ReturnType<typeof replaceOwner>>) {
    expect(treeStore.getState()).toBe(replacement.state);
    expect(getFileFreshness(tabId)).toBe(replacement.freshness);
    expect(jotaiStore.get(tabsAtom)[0]?.gameOrigin).toEqual(replacement.tabs[0]?.gameOrigin);
    expect(jotaiStore.get(tabsAtom)).toBe(replacement.tabs);
    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(replacement.workspace);
    expect(replacement.bytes).not.toBeNull();
    expect(tabStorage.flush()).toEqual([]);
    expect(sessionStorage.getItem(replacement.key)).toBe(replacement.bytes);
    expect(new TabStorageRepository().read(replacement.key)?.state).toMatchObject({
      headers: { event: "Replacement event" },
      root: { comment: "Replacement comment" },
      sourceStamp: "c".repeat(64),
    });
    expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
    expect(mocks.showNotification).not.toHaveBeenCalled();
  }

  test("composed Add Game withholds its real board and completes its own blank tree", async () => {
    const write = held<Written>();
    mocks.writeGame.mockReturnValueOnce(write.promise);
    await composed();
    await activate();
    expectPending();
    expect(mocks.writeGame).toHaveBeenCalledWith(fileHandle, 3, defaultPGN(), { kind: "append" });
    await act(async () => write.resolve({ stamp: "b".repeat(64), revision: "added" }));
    expectCompleted();
    expect(container.querySelector('[data-testid="add-game"]')).not.toBeNull();
    expect(mocks.showNotification).not.toHaveBeenCalled();
  });

  function coldPair() {
    const workspace = deserializeStorageValue<{ tabs: Tab[] }>(
      sessionStorage.getItem(WORKSPACE_STORAGE_KEY)!,
    )!;
    const owner = workspace.tabs.find((current) => current.value === tabId)!;
    return { owner, tree: new TabStorageRepository().read(getTabTreeKey(owner), true)?.state };
  }

  async function queuedCleanSave() {
    await composed();
    await act(async () => {
      treeStore.getState().setComment("Original durable dirty game");
      tabStorage.seed(tabId, treeStore.getState());
    });
    const bytes = sessionStorage.getItem(tabId);
    mocks.writeGame.mockResolvedValueOnce({ stamp: "d".repeat(64), revision: "saved" });
    await act(async () => expect(await startOrdinarySave()).toBe("saved"));
    expect(treeStore.getState()).toMatchObject({ dirty: false, sourceStamp: "d".repeat(64) });
    expect(sessionStorage.getItem(tabId)).toBe(bytes);
    expect(new TabStorageRepository().read(tabId)?.state).toMatchObject({
      dirty: true,
      root: { comment: "Original durable dirty game" },
      sourceStamp: "a".repeat(64),
    });
    expect(tabStorage.read(tabId)?.state).toMatchObject({
      dirty: false,
      sourceStamp: "d".repeat(64),
    });
    return { bytes, pending: tabStorage.read(tabId)?.state };
  }

  test("composed accepted Add Game has an immediate cold blank pair despite refused old pending writes", async () => {
    await queuedCleanSave();
    const write = held<Written>();
    mocks.writeGame.mockReturnValueOnce(write.promise);
    await activate();
    expectPending();
    await act(async () => write.resolve({ stamp: "b".repeat(64), revision: "added" }));
    const cold = coldPair();
    expect(cold.owner.gameOrigin).toMatchObject({
      kind: "file",
      gameNumber: 3,
      file: { numGames: 4 },
    });
    expect(cold.tree).toMatchObject({
      dirty: false,
      root: { children: [], comment: "" },
      headers: { event: "?" },
      sourceStamp: "b".repeat(64),
    });
    expectCompleted();
    expect(getTabTreeKey(cold.owner)).not.toBe(tabId);
    const originalSet = Storage.prototype.setItem;
    const refuseOld = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key === tabId) throw new DOMException("Old writes refused", "QuotaExceededError");
        return originalSet.call(this, key, value);
      });
    try {
      expect(tabStorage.flush()).toEqual([]);
      expect(coldPair()).toMatchObject(cold);
      expect(mocks.showNotification).not.toHaveBeenCalled();
    } finally {
      refuseOld.mockRestore();
    }
  });

  test("composed accepted Add Game admits the file origin and count from a temporary source", async () => {
    await composed();
    if (!isFileBackedTab(tab)) throw new Error("Expected file owner");
    await act(async () => {
      jotaiStore.set(
        tabsAtom,
        [{ ...tab, gameOrigin: { ...tab.gameOrigin, kind: "temp_file" } }],
        tabId,
      );
    });
    await activate();
    expect(coldPair().owner.gameOrigin).toMatchObject({
      kind: "file",
      gameNumber: 3,
      file: { numGames: 4 },
    });
    expect(coldPair().tree).toMatchObject({
      dirty: false,
      root: { children: [], comment: "" },
      sourceStamp: "b".repeat(64),
    });
    expect(getFileFreshness(tabId)).toMatchObject({
      state: "verified",
      verifiedRevision: "new-revision",
    });
  });

  test.each(["tree", "workspace"] as const)(
    "composed accepted Add Game refuses %s admission and retains the old pair and pending Save bytes",
    async (stage) => {
      const old = await queuedCleanSave();
      const owners = jotaiStore.get(tabsAtom);
      const workspace = sessionStorage.getItem(WORKSPACE_STORAGE_KEY);
      const state = treeStore.getState();
      const write = held<Written>();
      mocks.writeGame.mockReturnValueOnce(write.promise);
      await activate();
      const originalSet = Storage.prototype.setItem;
      const refused = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(function (this: Storage, key, value) {
          if (
            stage === "workspace"
              ? key === WORKSPACE_STORAGE_KEY
              : /^[0-9a-f-]{36}$/.test(key) && key !== tabId
          )
            throw new DOMException("Admission refused", "QuotaExceededError");
          return originalSet.call(this, key, value);
        });
      try {
        await act(async () => write.resolve({ stamp: "b".repeat(64), revision: "added" }));
        expect(coldPair().owner.gameOrigin).toEqual(tab.gameOrigin);
        expect(coldPair().tree).toMatchObject({
          dirty: true,
          root: { comment: "Original durable dirty game" },
          sourceStamp: "a".repeat(64),
        });
        expect(jotaiStore.get(tabsAtom)).toBe(owners);
        expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(workspace);
        expect(sessionStorage.getItem(tabId)).toBe(old.bytes);
        expect(tabStorage.read(tabId)?.state).toEqual(old.pending);
        expect(treeStore.getState()).toBe(state);
        expect(getFileFreshness(tabId).state).toBe("unverified");
        expect(container.textContent).not.toContain("FileFreshness.AddingGame");
        expect(mocks.countPgnGames).not.toHaveBeenCalled();
        expect(mocks.showNotification).toHaveBeenCalledOnce();
      } finally {
        refused.mockRestore();
      }
      await act(async () => setFileFreshness(tabId, "verified", { verifiedRevision: "saved" }));
      await activate();
      expect(mocks.writeGame).toHaveBeenCalledTimes(3);
      expect(getFileFreshness(tabId).state).toBe("verified");
    },
  );

  test.each(["workspace", "tree"] as const)(
    "composed Add Game settles admitted successor after actual %s subscriber failure and completed reconciliation",
    async (subscriber) => {
      const old = await queuedCleanSave();
      mocks.countPgnGames.mockResolvedValueOnce(99);
      const write = held<Written>();
      mocks.writeGame.mockReturnValueOnce(write.promise);
      await activate();
      let threw = false;
      const listener = () => {
        if (threw || treeStore.getState().sourceStamp !== "b".repeat(64)) return;
        threw = true;
        expect(jotaiStore.get(tabsAtom)[0]?.gameOrigin).toMatchObject({ gameNumber: 3 });
        throw new Error("Retarget follow-up failed at /private/game.pgn token=secret");
      };
      const unsubscribe =
        subscriber === "workspace"
          ? jotaiStore.sub(tabsAtom, listener)
          : treeStore.subscribe(listener);
      const read = held<{ pgn: string; stamp: string; revision: string; present: boolean }>();
      const oldPgn = '[Event "Previous page"]\n\n1. e4 *';
      const admittedPgn = '[Event "Admitted page"]\n\n*';
      mocks.readGame.mockImplementation((_handle, page, options) => {
        if (page === 3) {
          options?.signal.addEventListener(
            "abort",
            () => read.reject({ category: "cancellation", message: "Cancellation" }),
            { once: true },
          );
          return read.promise;
        }
        return Promise.resolve({
          pgn: oldPgn,
          stamp: "c".repeat(64),
          revision: "wrong-page",
          present: true,
        });
      });
      mocks.parsePGN.mockImplementation(async (pgn) => {
        const tree = defaultTree();
        tree.headers.event =
          pgn === oldPgn ? "Previous page" : pgn === admittedPgn ? "Admitted page" : "?";
        tree.root.comment =
          pgn === oldPgn ? "Previous-page content must not reach admitted key" : "";
        return tree;
      });
      try {
        await act(async () => write.resolve({ stamp: "b".repeat(64), revision: "added" }));
        const cold = coldPair();
        expect(cold.owner.gameOrigin).toMatchObject({ gameNumber: 3, file: { numGames: 4 } });
        expect(cold.tree).toMatchObject({
          root: { children: [], comment: "" },
          headers: { event: "?" },
          sourceStamp: "b".repeat(64),
        });
        expect(sessionStorage.getItem(tabId)).toBe(old.bytes);
        expect(tabStorage.read(tabId)?.state).toEqual(old.pending);
        expect(threw).toBe(true);
        expect(jotaiStore.get(tabsAtom)[0]).toEqual(cold.owner);
        expect(treeStore.getState()).toMatchObject(cold.tree!);
        expect(mocks.countPgnGames).not.toHaveBeenCalled();
        expect(getFileFreshness(tabId).state).toBe("unverified");
        expect(container.textContent).not.toContain("FileFreshness.AddingGame");
        expect(mocks.showNotification).toHaveBeenCalledOnce();
        expect(mocks.showNotification.mock.calls[0]?.[0].message).toContain(
          "FileFreshness.AddGameMayHaveBeenAdded",
        );
        const cause = mocks.notifyUnlessCancelled.mock.calls[0]?.[1];
        expect(cause).toMatchObject({ category: "unexpected" });
        const message = `FileFreshness.AddGameMayHaveBeenAdded ${subscriber === "workspace" ? "Aggregate error: " : ""}Retarget follow-up failed at [path] token=[redacted]`;
        expect(normalizeError(cause).message).toBe(message);
        expect(mocks.showNotification.mock.calls[0]?.[0].message).toBe(message);
        expect(getAddGameLease(treeStore)).toBeNull();
        expect(mocks.readGame.mock.calls.map(([, page]) => page)).toEqual([1, 3]);
        await act(async () =>
          read.resolve({
            pgn: admittedPgn,
            stamp: "c".repeat(64),
            revision: "reconciled",
            present: true,
          }),
        );
        expect(getFileFreshness(tabId)).toMatchObject({
          state: "verified",
          verifiedRevision: "reconciled",
        });
        expect(tabStorage.flush()).toEqual([]);
        expect(coldPair()).toMatchObject({
          owner: cold.owner,
          tree: {
            headers: { event: "Admitted page" },
            root: { comment: "", children: [] },
            sourceStamp: "c".repeat(64),
          },
        });
        await navigate(awayTab.value);
        await navigate(tabId);
        expect(container.querySelector('[data-testid="add-game"]')).not.toBeNull();
        await activate();
        expect(getFileFreshness(tabId).state).toBe("verified");
      } finally {
        unsubscribe();
        await act(async () =>
          read.resolve({
            pgn: admittedPgn,
            stamp: "c".repeat(64),
            revision: "reconciled",
            present: true,
          }),
        );
      }
    },
  );

  test("composed reconciliation after an installed observer failure preserves the admitted cold page content", async () => {
    await queuedCleanSave();
    const oldPgn = '[Event "Previous page"]\n\n1. e4 *';
    const admittedPgn = '[Event "Admitted page"]\n\n*';
    mocks.readGame.mockImplementation(async (_handle, page) => ({
      pgn: page === 3 ? admittedPgn : oldPgn,
      stamp: "c".repeat(64),
      revision: "reconciled",
      present: true,
    }));
    mocks.parsePGN.mockImplementation(async (pgn) => {
      const tree = defaultTree();
      tree.headers.event =
        pgn === oldPgn ? "Previous page" : pgn === admittedPgn ? "Admitted page" : "?";
      tree.root.comment = pgn === oldPgn ? "Previous-page content" : "";
      return tree;
    });
    const write = held<Written>();
    mocks.writeGame.mockReturnValueOnce(write.promise);
    await activate();
    let threw = false;
    const unsubscribe = treeStore.subscribe(() => {
      if (threw || treeStore.getState().sourceStamp !== "b".repeat(64)) return;
      threw = true;
      throw new Error("Installed observer failed");
    });
    try {
      await act(async () => write.resolve({ stamp: "b".repeat(64), revision: "added" }));
      expect(threw).toBe(true);
      expect(tabStorage.flush()).toEqual([]);
      const cold = coldPair();
      expect((cold.tree as ReturnType<typeof defaultTree> | undefined)?.root.comment).toBe("");
      expect(cold.tree).toMatchObject({
        headers: { event: "Admitted page" },
        sourceStamp: "c".repeat(64),
        dirty: false,
      });
      expect(cold.owner.gameOrigin).toMatchObject({ gameNumber: 3, file: { numGames: 4 } });
      expect(treeStore.getState()).toMatchObject(cold.tree!);
      expect(jotaiStore.get(tabsAtom)[0]).toEqual(cold.owner);
      expect(getFileFreshness(tabId)).toMatchObject({
        state: "verified",
        verifiedRevision: "reconciled",
      });
      expect(mocks.showNotification).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });

  test.each([
    "workspace-replacement",
    "tree-replacement",
    "workspace-removal",
    "tree-removal",
  ] as const)(
    "composed Add Game remains silent after reentrant %s subscriber failure",
    async (scenario) => {
      await queuedCleanSave();
      const write = held<Written>();
      mocks.writeGame.mockReturnValueOnce(write.promise);
      await activate();
      let reentered = false;
      let foreign: Tab | undefined;
      let replacementKind: string | undefined;
      const listener = () => {
        if (reentered || treeStore.getState().sourceStamp !== "b".repeat(64)) return;
        reentered = true;
        const admitted = jotaiStore.get(tabsAtom).find((current) => current.value === tabId)!;
        if (!isFileBackedTab(admitted)) throw new Error("Expected canonical admitted owner");
        if (scenario.endsWith("removal")) {
          jotaiStore.set(closeWorkspaceTabAtom, tabId);
        } else {
          const tree = defaultTree();
          tree.headers.event = "Foreign replacement";
          tree.sourceStamp = "f".repeat(64);
          replacementKind = replaceFileGame({
            store: jotaiStore,
            owner: admitted,
            treeStore,
            snapshot: treeStore.getState(),
            tree,
            page: 0,
            isCurrent: () => true,
          }).kind;
          foreign = jotaiStore.get(tabsAtom).find((current) => current.value === tabId);
        }
        setFileFreshness(tabId, "verified", { verifiedRevision: "foreign" });
        throw new Error("Foreign observer failed");
      };
      const unsubscribe = scenario.startsWith("workspace")
        ? jotaiStore.sub(tabsAtom, listener)
        : treeStore.subscribe(listener);
      try {
        await act(async () => write.resolve({ stamp: "b".repeat(64), revision: "added" }));
        expect(reentered).toBe(true);
        expect(replacementKind).toBe(scenario.endsWith("removal") ? undefined : "committed");
        expect(jotaiStore.get(tabsAtom).find((current) => current.value === tabId)).toEqual(
          foreign,
        );
        expect(getFileFreshness(tabId)).toMatchObject({
          state: "verified",
          verifiedRevision: "foreign",
        });
        expect(mocks.showNotification).not.toHaveBeenCalled();
        expect(mocks.countPgnGames).not.toHaveBeenCalled();
        expect(mocks.readGame).toHaveBeenCalledExactlyOnceWith(fileHandle, 1, undefined);
        expect(tabStorage.flush()).toEqual([]);
        const durable = deserializeStorageValue<{ tabs: Tab[] }>(
          sessionStorage.getItem(WORKSPACE_STORAGE_KEY)!,
        )!;
        expect(durable.tabs.find((current) => current.value === tabId)).toEqual(foreign);
        const foreignCold = foreign
          ? (coldPair().tree as ReturnType<typeof defaultTree>)
          : undefined;
        expect(foreignCold?.headers.event).toBe(foreign ? "Foreign replacement" : undefined);
        expect(foreignCold?.sourceStamp).toBe(foreign ? "f".repeat(64) : undefined);
      } finally {
        unsubscribe();
      }
    },
  );

  test.each(["stale-game", "unknown-fulfillment"] as const)(
    "composed %s count publication refusal preserves the old count and truthful notifications",
    async (outcome) => {
      await composed();
      const old = coldPair();
      const workspace = sessionStorage.getItem(WORKSPACE_STORAGE_KEY);
      const count = held<number>();
      mocks.countPgnGames.mockReturnValueOnce(count.promise);
      if (outcome === "stale-game")
        mocks.writeGame.mockRejectedValueOnce({
          tag: "backend-error",
          category: "stale-game",
          message: "Stale append index",
        });
      else mocks.writeGame.mockResolvedValueOnce({ stamp: null, revision: null });
      await activate();
      const originalSet = Storage.prototype.setItem;
      const refused = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(function (this: Storage, key, value) {
          if (key === WORKSPACE_STORAGE_KEY)
            throw new DOMException("Count refused", "QuotaExceededError");
          return originalSet.call(this, key, value);
        });
      try {
        await act(async () => count.resolve(99));
        expect(jotaiStore.get(tabsAtom)[0]?.gameOrigin).toEqual(tab.gameOrigin);
        expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(workspace);
        expect(coldPair()).toEqual(old);
        expect(getFileFreshness(tabId).state).toBe("unverified");
        expect(container.textContent).not.toContain("FileFreshness.AddingGame");
        const storageMessage = expect.stringContaining("session storage is full");
        expect(mocks.showNotification.mock.calls.map(([notice]) => notice.message)).toEqual(
          outcome === "stale-game"
            ? [storageMessage]
            : [storageMessage, "FileFreshness.AddGameMayHaveBeenAdded"],
        );
        expect(
          mocks.notifyUnlessCancelled.mock.calls.some(([, error]) => error === undefined),
        ).toBe(false);
        expect(mocks.countPgnGames).toHaveBeenCalledOnce();
      } finally {
        refused.mockRestore();
      }
    },
  );

  test("composed Add Game settles while its gate is absent and returns to the completed board", async () => {
    const write = held<Written>();
    mocks.writeGame.mockReturnValueOnce(write.promise);
    await composed();
    await activate();
    expectPending();
    await navigate(awayTab.value);
    await act(async () => write.resolve({ stamp: "b".repeat(64), revision: "added" }));
    expectCompleted();
    expect(container.textContent).toBe("away");
    expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
    await navigate(tabId);
    expect(container.querySelector('[data-testid="add-game"]')).not.toBeNull();
    expectCompleted();
  });

  test("composed held parsing remains single-flight after navigation and remount", async () => {
    const parse = held<ReturnType<typeof defaultTree>>();
    mocks.parsePGN.mockReturnValueOnce(parse.promise);
    await composed();
    await activate();
    expectPending();
    await navigate(awayTab.value);
    await navigate(tabId);
    expectPending();
    await activate();
    expect(mocks.parsePGN).toHaveBeenCalledOnce();
    expect(mocks.writeGame).not.toHaveBeenCalled();
    await act(async () => parse.resolve(defaultTree()));
    expect(mocks.writeGame).toHaveBeenCalledOnce();
    expect(getFileFreshness(tabId).state).toBe("verified");
  });

  test("composed synchronous Add Game admission precedes parsing and rejects a second activation", async () => {
    const parse = held<ReturnType<typeof defaultTree>>();
    mocks.parsePGN.mockReturnValueOnce(parse.promise);
    await composed();
    await act(async () => {
      mocks.addGameActivation?.();
      mocks.addGameActivation?.();
    });
    expect(mocks.parsePGN).toHaveBeenCalledOnce();
    expectPending();
    await act(async () => parse.resolve(defaultTree()));
    expect(mocks.writeGame).toHaveBeenCalledOnce();
  });

  test("composed real Board Save hotkey preserves its stamp while pending Add Game survives remount", async () => {
    const save = held<Written>();
    const parse = held<ReturnType<typeof defaultTree>>();
    mocks.writeGame.mockReturnValueOnce(save.promise);
    mocks.parsePGN.mockReturnValueOnce(parse.promise);
    await composed();
    await act(async () => {
      latestSaveHotkey()();
    });
    expect(mocks.writeGame).toHaveBeenCalledOnce();
    await activate();
    await navigate(awayTab.value);
    await act(async () => save.resolve({ stamp: "d".repeat(64), revision: "hotkey-saved" }));
    expect(treeStore.getState()).toMatchObject({ dirty: false, sourceStamp: "d".repeat(64) });
    const saved = getFileFreshness(tabId);
    expect(saved).toMatchObject({ state: "verified", verifiedRevision: "hotkey-saved" });
    await navigate(tabId);
    expectPending();
    await activate();
    expect(mocks.parsePGN).toHaveBeenCalledOnce();
    expect(mocks.writeGame).toHaveBeenCalledOnce();
    expect(getFileFreshness(tabId)).toBe(saved);
    expect(treeStore.getState().sourceStamp).toBe("d".repeat(64));
    await act(async () => parse.resolve(defaultTree()));
    expect(mocks.writeGame).toHaveBeenCalledTimes(2);
    expect(treeStore.getState().sourceStamp).toBe("b".repeat(64));
    expect(container.querySelector('[data-testid="add-game"]')).not.toBeNull();
  });

  test("composed active parse failure restores the board, reports its typed error and releases admission", async () => {
    mocks.parsePGN.mockRejectedValueOnce({
      tag: "backend-error",
      category: "invalid-input",
      message: "Blank parse failed",
    });
    await composed();
    await activate();
    expect(getFileFreshness(tabId)).toMatchObject({
      state: "verified",
      verifiedRevision: "original-revision",
    });
    expect(container.querySelector('[data-testid="add-game"]')).not.toBeNull();
    expectNotification(
      normalizeError({
        tag: "backend-error",
        category: "invalid-input",
        message: "Blank parse failed",
      }),
    );
    expect(mocks.writeGame).not.toHaveBeenCalled();
    await activate();
    expect(mocks.parsePGN).toHaveBeenCalledTimes(2);
    expect(mocks.writeGame).toHaveBeenCalledOnce();
  });

  test("composed successful Add Game preserves current unrelated tab and file metadata", async () => {
    const write = held<Written>();
    mocks.writeGame.mockReturnValueOnce(write.promise);
    await composed();
    await activate();
    await act(async () => {
      expect(
        jotaiStore.set(tabsAtom, (owners) =>
          owners.map((owner) =>
            isFileBackedTab(owner)
              ? {
                  ...owner,
                  name: "Renamed while adding",
                  gameOrigin: {
                    ...owner.gameOrigin,
                    file: {
                      ...owner.gameOrigin.file,
                      name: "Current file name",
                      lastModified: 99,
                      metadata: { type: "repertoire", tags: ["current tag"] },
                    },
                  },
                }
              : owner,
          ),
        ),
      ).toBe(true);
      write.resolve({ stamp: "b".repeat(64), revision: "added" });
    });
    expectCompleted();
    expect(jotaiStore.get(tabsAtom)[0]).toMatchObject({
      name: "Current file name",
      gameOrigin: {
        file: {
          name: "Current file name",
          lastModified: 99,
          metadata: { type: "repertoire", tags: ["current tag"] },
        },
      },
    });
  });

  test("composed cached-store replacement defeats Add Game even when logical and physical references match", async () => {
    const parse = held<ReturnType<typeof defaultTree>>();
    mocks.parsePGN.mockReturnValueOnce(parse.promise);
    await composed();
    await activate();
    await navigate(awayTab.value);
    const retired = treeStore;
    expect(tabStorage.flush()).toEqual([]);
    closeTreeStore(tabId);
    const candidate = defaultTree();
    candidate.headers.event = "New cached owner";
    candidate.sourceStamp = "c".repeat(64);
    tabStorage.seed(tabId, candidate);
    treeStore = createTreeStore(tabId);
    setFileFreshness(tabId, "verified", { verifiedRevision: "new-cache" });
    expect(treeStore).not.toBe(retired);
    const state = treeStore.getState();
    const freshness = getFileFreshness(tabId);
    const owners = jotaiStore.get(tabsAtom);
    const bytes = sessionStorage.getItem(tabId);
    await act(async () => parse.resolve(defaultTree()));
    expect(mocks.writeGame).not.toHaveBeenCalled();
    expect(treeStore.getState()).toBe(state);
    expect(getFileFreshness(tabId)).toBe(freshness);
    expect(jotaiStore.get(tabsAtom)).toBe(owners);
    expect(tabStorage.flush()).toEqual([]);
    expect(sessionStorage.getItem(tabId)).toBe(bytes);
    await navigate(tabId);
    expect(treeStore.getState().headers.event).toBe("New cached owner");
    expect(container.querySelector('[data-testid="add-game"]')).not.toBeNull();
  });

  test.each(["success", "conflict", "unavailable", "unknown-write", "io"] as const)(
    "composed competing Save %s cannot release admission and its result survives inactive parse failure",
    async (outcome) => {
      const save = held<Written>();
      const parse = held<ReturnType<typeof defaultTree>>();
      mocks.writeGame.mockReturnValueOnce(save.promise);
      mocks.parsePGN.mockReturnValueOnce(parse.promise);
      await composed();
      const saving = startOrdinarySave();
      await vi.waitFor(() =>
        expect(mocks.writeGame).toHaveBeenCalledWith(fileHandle, 1, expect.any(String), {
          kind: "game",
          stamp: "a".repeat(64),
        }),
      );
      await activate();
      await navigate(awayTab.value);
      let result: Awaited<ReturnType<typeof saveToFile>>;
      await act(async () => {
        if (outcome === "success") save.resolve({ stamp: "d".repeat(64), revision: "saved" });
        else if (outcome === "unknown-write") save.resolve({ stamp: null, revision: null });
        else
          save.reject({
            tag: "backend-error",
            category: outcome === "unavailable" ? "missing-resource" : outcome,
            message: "Competing Save diagnostic",
          });
        result = await saving;
      });
      const expectedFailure = expect.objectContaining({
        status: "failed",
        error: expect.objectContaining({ message: "Competing Save diagnostic" }),
      });
      expect(result!).toEqual(
        outcome === "success"
          ? "saved"
          : outcome === "unavailable" || outcome === "unknown-write"
            ? "conflict"
            : expectedFailure,
      );
      const savedTree = treeStore.getState();
      const savedFreshness = getFileFreshness(tabId);
      expect(savedTree.sourceStamp).toBe(
        outcome === "success"
          ? "d".repeat(64)
          : outcome === "unknown-write"
            ? null
            : "a".repeat(64),
      );
      expect(savedFreshness).toMatchObject({
        state:
          outcome === "success"
            ? "verified"
            : outcome === "unavailable"
              ? "unavailable"
              : outcome === "io"
                ? "appending"
                : "unverified",
        verifiedRevision: outcome === "success" ? "saved" : null,
        errorMessage: outcome === "conflict" ? "Competing Save diagnostic" : null,
      });
      await navigate(tabId);
      expectPending();
      await activate();
      expect(mocks.parsePGN).toHaveBeenCalledOnce();
      expect(mocks.writeGame).toHaveBeenCalledOnce();
      expect(mocks.readGame).toHaveBeenCalledExactlyOnceWith(fileHandle, 1, undefined);
      expect(treeStore.getState().sourceStamp).toBe(savedTree.sourceStamp);
      await navigate(awayTab.value);
      await act(async () => parse.reject(new Error("Inactive parse failure")));
      expect(treeStore.getState()).toBe(savedTree);
      expect(getFileFreshness(tabId).verifiedRevision).toBe(
        outcome === "io" ? "original-revision" : savedFreshness.verifiedRevision,
      );
      expect(getFileFreshness(tabId) === savedFreshness).toBe(outcome !== "io");
      expect(getFileFreshness(tabId)).toMatchObject(
        outcome === "io"
          ? { state: "verified", verifiedRevision: "original-revision" }
          : savedFreshness,
      );
      expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
      expect(mocks.showNotification).not.toHaveBeenCalled();
      await navigate(tabId);
      expect(container.textContent).not.toContain("FileFreshness.AddingGame");
      expect(container.textContent?.includes("Competing Save diagnostic")).toBe(
        outcome === "conflict",
      );
    },
  );

  test.each([
    "parse-failure",
    "unknown-stamp",
    "unknown-revision",
    "write-failure",
    "count-failure",
    "durable-refusal",
  ] as const)(
    "composed inactive %s reaches terminal freshness without obsolete view notifications",
    async (outcome) => {
      const parse = held<ReturnType<typeof defaultTree>>();
      const write = held<Written>();
      mocks.parsePGN.mockReturnValueOnce(parse.promise);
      mocks.writeGame.mockReturnValueOnce(write.promise);
      if (outcome === "count-failure")
        mocks.countPgnGames.mockRejectedValueOnce(new Error("Inactive count failure"));
      await composed();
      await activate();
      await navigate(awayTab.value);
      if (outcome === "parse-failure")
        await act(async () => parse.reject(new Error("Inactive parse failure")));
      else {
        await act(async () => parse.resolve(defaultTree()));
        const originalSet = Storage.prototype.setItem;
        const refuse =
          outcome === "durable-refusal"
            ? vi
                .spyOn(Storage.prototype, "setItem")
                .mockImplementation(function (this: Storage, key, value) {
                  if (key === WORKSPACE_STORAGE_KEY)
                    throw new DOMException("Workspace refused", "QuotaExceededError");
                  return originalSet.call(this, key, value);
                })
            : undefined;
        await act(async () => {
          if (outcome === "write-failure") write.reject(new Error("Inactive write failure"));
          else
            write.resolve({
              stamp:
                outcome === "unknown-stamp" || outcome === "count-failure" ? null : "b".repeat(64),
              revision: outcome === "unknown-revision" ? null : "added",
            });
        });
        refuse?.mockRestore();
      }
      expect(container.textContent).toBe("away");
      expect(getFileFreshness(tabId).state).toBe(
        outcome === "parse-failure" ? "verified" : "unverified",
      );
      expect(treeStore.getState()).toMatchObject({
        sourceStamp: "a".repeat(64),
        headers: { event: "Keep this tree" },
      });
      expect(jotaiStore.get(tabsAtom)[0]?.gameOrigin).toMatchObject({ gameNumber: 1 });
      // Workspace refusal retains the pre-existing global persistence diagnostic. The obsolete
      // Add Game view emits no operation notification of its own.
      expect(
        mocks.notifyUnlessCancelled.mock.calls.filter(([, error]) =>
          normalizeError(error).message.startsWith("FileFreshness."),
        ),
      ).toEqual([]);
      expect(mocks.showNotification).toHaveBeenCalledTimes(outcome === "durable-refusal" ? 1 : 0);
      await navigate(tabId);
      expect(container.textContent).not.toContain("FileFreshness.AddingGame");
      expect(container.querySelector('[data-testid="add-game"]') !== null).toBe(
        outcome === "parse-failure",
      );
    },
  );

  test.each([
    "parse-success",
    "parse-failure",
    "write-success",
    "write-unknown",
    "write-failure",
    "count-success",
    "count-failure",
  ] as const)(
    "composed durable physical-only replacement silences obsolete Add Game %s",
    async (boundary) => {
      const parse = held<ReturnType<typeof defaultTree>>();
      const write = held<Written>();
      const count = held<number>();
      if (boundary.startsWith("parse")) mocks.parsePGN.mockReturnValueOnce(parse.promise);
      else mocks.writeGame.mockReturnValueOnce(write.promise);
      if (boundary.startsWith("count")) mocks.countPgnGames.mockReturnValueOnce(count.promise);
      await composed();
      await activate();
      if (boundary.startsWith("count"))
        await act(async () => write.resolve({ stamp: null, revision: null }));
      const replacement = await replaceOwner();
      await act(async () => {
        if (boundary === "parse-success") parse.resolve(defaultTree());
        if (boundary === "parse-failure") parse.reject(new Error("Obsolete parse"));
        if (boundary === "write-success")
          write.resolve({ stamp: "b".repeat(64), revision: "obsolete" });
        if (boundary === "write-unknown") write.resolve({ stamp: null, revision: null });
        if (boundary === "write-failure") write.reject(new Error("Obsolete write"));
        if (boundary === "count-success") count.resolve(99);
        if (boundary === "count-failure") count.reject(new Error("Obsolete count"));
      });
      expectReplacement(replacement);
      expect(mocks.writeGame).toHaveBeenCalledTimes(boundary.startsWith("parse") ? 0 : 1);
      expect(mocks.countPgnGames).toHaveBeenCalledTimes(boundary.startsWith("count") ? 1 : 0);
      expect(container.querySelector('[data-testid="add-game"]')).not.toBeNull();
    },
  );

  test.each(["parse", "write", "count"] as const)(
    "composed actual tab removal suppresses the held %s continuation",
    async (boundary) => {
      const parse = held<ReturnType<typeof defaultTree>>();
      const write = held<Written>();
      const count = held<number>();
      if (boundary === "parse") mocks.parsePGN.mockReturnValueOnce(parse.promise);
      else mocks.writeGame.mockReturnValueOnce(write.promise);
      if (boundary === "count") mocks.countPgnGames.mockReturnValueOnce(count.promise);
      await composed();
      await activate();
      if (boundary === "count")
        await act(async () => write.resolve({ stamp: null, revision: null }));
      await act(async () => {
        expect(jotaiStore.set(closeWorkspaceTabAtom, tabId)).toBe(true);
        closeTreeStore(tabId);
      });
      const owners = jotaiStore.get(tabsAtom);
      const bytes = sessionStorage.getItem(WORKSPACE_STORAGE_KEY);
      const state = treeStore.getState();
      const freshness = getFileFreshness(tabId);
      await act(async () => {
        if (boundary === "parse") parse.resolve(defaultTree());
        if (boundary === "write") write.reject(new Error("Removed owner write"));
        if (boundary === "count") count.resolve(99);
      });
      expect(jotaiStore.get(tabsAtom)).toBe(owners);
      expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(bytes);
      expect(treeStore.getState()).toBe(state);
      expect(getFileFreshness(tabId)).toBe(freshness);
      expect(sessionStorage.getItem(tabId)).toBeNull();
      expect(container.textContent).toBe("away");
      expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
      expect(mocks.showNotification).not.toHaveBeenCalled();
      expect(mocks.writeGame).toHaveBeenCalledTimes(boundary === "parse" ? 0 : 1);
      expect(mocks.countPgnGames).toHaveBeenCalledTimes(boundary === "count" ? 1 : 0);
    },
  );

  test("composed competing Save preserves the live and cold saved game while the original Add Game parse is pending", async () => {
    const save = held<Written>();
    const parse = held<ReturnType<typeof defaultTree>>();
    const blank = defaultTree();
    blank.headers.event = "?";
    mocks.writeGame
      .mockReturnValueOnce(save.promise)
      .mockResolvedValue({ stamp: "b".repeat(64), revision: "added" });
    mocks.parsePGN.mockReturnValueOnce(parse.promise);
    await composed();
    const saving = startOrdinarySave();
    try {
      await activate();
      expectPending();
      await act(async () => {
        save.resolve({ stamp: "d".repeat(64), revision: "saved" });
        expect(await saving).toBe("saved");
      });
      expect(getFileFreshness(tabId)).toMatchObject({
        state: "verified",
        verifiedRevision: "saved",
      });
      // Flush the completed original Save, before either Add Game can admit a candidate.
      expect(tabStorage.flush()).toEqual([]);
      const savedOwner = jotaiStore.get(tabsAtom)[0]!;
      const savedKey = getTabTreeKey(savedOwner);
      const savedTree = {
        dirty: false,
        sourceStamp: "d".repeat(64),
        headers: { event: "Keep this tree" },
        root: { children: [], comment: "" },
      };
      expect(savedOwner.gameOrigin).toMatchObject({
        kind: "file",
        gameNumber: 1,
        file: { numGames: 3 },
      });
      expect(coldPair()).toMatchObject({ owner: savedOwner, tree: savedTree });
      await navigate(awayTab.value);
      await navigate(tabId);
      await activate();
      expect(jotaiStore.get(tabsAtom)[0]).toEqual(savedOwner);
      expect(getTabTreeKey(jotaiStore.get(tabsAtom)[0]!)).toBe(savedKey);
      expect(treeStore.getState()).toMatchObject(savedTree);
      expect(coldPair()).toMatchObject({ owner: savedOwner, tree: savedTree });
      expectPending();
      await act(async () => parse.resolve(blank));
      expectCompleted();
      const completed = coldPair();
      expect(getTabTreeKey(completed.owner)).not.toBe(savedKey);
      expect(completed.owner).toEqual(jotaiStore.get(tabsAtom)[0]);
      expect(completed.tree).toMatchObject({
        dirty: false,
        sourceStamp: "b".repeat(64),
        headers: { event: "?" },
        root: { children: [], comment: "" },
      });
      expect(container.querySelector('[data-testid="add-game"]')).not.toBeNull();
      expect(container.textContent).not.toContain("FileFreshness.AddingGame");
      expect(mocks.writeGame.mock.calls.map(([, page, , origin]) => ({ page, origin }))).toEqual([
        { page: 1, origin: { kind: "game", stamp: "a".repeat(64) } },
        { page: 3, origin: { kind: "append" } },
      ]);
      expect(mocks.showNotification.mock.calls).toEqual([]);
    } finally {
      await act(async () => {
        save.resolve({ stamp: "d".repeat(64), revision: "saved" });
        parse.resolve(blank);
        await saving;
      });
    }
  });

  test("composed replacement admits its own Add Game and retains pending presentation after the old parse settles", async () => {
    const oldParse = held<ReturnType<typeof defaultTree>>();
    const newParse = held<ReturnType<typeof defaultTree>>();
    const blank = defaultTree();
    blank.headers.event = "?";
    mocks.parsePGN.mockReturnValueOnce(oldParse.promise).mockReturnValueOnce(newParse.promise);
    mocks.writeGame.mockResolvedValue({ stamp: "b".repeat(64), revision: "added" });
    await composed();
    try {
      await activate();
      expectPending();
      const originalKey = getTabTreeKey(jotaiStore.get(tabsAtom)[0]!);
      await replaceOwner();
      const replacementOwner = jotaiStore.get(tabsAtom)[0]!;
      const replacementKey = getTabTreeKey(replacementOwner);
      expect(replacementKey).not.toBe(originalKey);
      expect(container.querySelector('[data-testid="add-game"]')).not.toBeNull();
      await activate();
      expectPending();
      await act(async () => oldParse.resolve(defaultTree()));
      expectPending();
      expect(jotaiStore.get(tabsAtom)[0]).toEqual(replacementOwner);
      expect(treeStore.getState()).toMatchObject({
        headers: { event: "Replacement event" },
        root: { comment: "Replacement comment" },
        sourceStamp: "c".repeat(64),
      });
      expect(coldPair()).toMatchObject({
        owner: replacementOwner,
        tree: {
          headers: { event: "Replacement event" },
          root: { comment: "Replacement comment" },
          sourceStamp: "c".repeat(64),
        },
      });
      await act(async () => newParse.resolve(blank));
      expectCompleted();
      const completed = coldPair();
      expect(completed.owner).toEqual(jotaiStore.get(tabsAtom)[0]);
      expect(getTabTreeKey(completed.owner)).not.toBe(replacementKey);
      expect(completed.tree).toMatchObject({
        dirty: false,
        sourceStamp: "b".repeat(64),
        headers: { event: "?" },
        root: { children: [], comment: "" },
      });
      expect(container.querySelector('[data-testid="add-game"]')).not.toBeNull();
      expect(container.textContent).not.toContain("FileFreshness.AddingGame");
      expect(mocks.writeGame.mock.calls.map(([, page, , origin]) => ({ page, origin }))).toEqual([
        { page: 3, origin: { kind: "append" } },
      ]);
      expect(mocks.showNotification.mock.calls).toEqual([]);
    } finally {
      await act(async () => {
        oldParse.resolve(defaultTree());
        newParse.resolve(blank);
      });
    }
  });

  test("composed obsolete release cannot release a newer physical generation's admission", async () => {
    const oldParse = held<ReturnType<typeof defaultTree>>();
    const newParse = held<ReturnType<typeof defaultTree>>();
    mocks.parsePGN.mockReturnValueOnce(oldParse.promise).mockReturnValueOnce(newParse.promise);
    await composed();
    await activate();
    await replaceOwner();
    await activate();
    expect(mocks.parsePGN).toHaveBeenCalledTimes(2);
    expectPending();
    await act(async () => oldParse.resolve(defaultTree()));
    expectPending();
    await act(async () => setFileFreshness(tabId, "verified", { verifiedRevision: "newer Save" }));
    await navigate(awayTab.value);
    await navigate(tabId);
    expectPending();
    await activate();
    expect(mocks.parsePGN).toHaveBeenCalledTimes(2);
    expect(mocks.writeGame).not.toHaveBeenCalled();
    await act(async () => newParse.resolve(defaultTree()));
    expect(mocks.writeGame).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="add-game"]')).not.toBeNull();
  });

  test("composed independent provider and cached-store owners admit and complete independently", async () => {
    const otherId = crypto.randomUUID();
    const other = { ...tab, value: otherId, name: "Independent owner" };
    const otherWorkspace = createJotaiStore();
    const otherTree = defaultTree();
    otherTree.headers.event = "Independent tree";
    otherTree.sourceStamp = "a".repeat(64);
    tabStorage.seed(otherId, otherTree);
    const independentStore = createTreeStore(otherId);
    expect(otherWorkspace.set(tabsAtom, [other], otherId)).toBe(true);
    otherWorkspace.set(autoSaveAtom, false);
    setFileFreshness(otherId, "verified", { verifiedRevision: "independent" });
    const parse = held<ReturnType<typeof defaultTree>>();
    const otherParse = held<ReturnType<typeof defaultTree>>();
    mocks.parsePGN.mockReturnValueOnce(parse.promise).mockReturnValueOnce(otherParse.promise);
    await composed();
    await activate();
    expectPending();
    const otherHost = document.createElement("div");
    document.body.append(otherHost);
    const otherRoot = createRoot(otherHost);
    try {
      await act(async () =>
        otherRoot.render(
          <JotaiProvider store={otherWorkspace}>
            <ComposedBoardHarness />
          </JotaiProvider>,
        ),
      );
      await act(async () =>
        otherHost.querySelector<HTMLButtonElement>('[data-testid="add-game"]')!.click(),
      );
      expect(mocks.parsePGN).toHaveBeenCalledTimes(2);
      expect(mocks.writeGame).not.toHaveBeenCalled();
      await act(async () => {
        setFileFreshness(tabId, "verified", { verifiedRevision: "first Save" });
        setFileFreshness(otherId, "verified", { verifiedRevision: "independent Save" });
      });
      expectPending();
      expect(otherHost.querySelector('[data-testid="add-game"]')).toBeNull();
      expect(otherHost.textContent).toContain("FileFreshness.AddingGame");
      const secondBlank = defaultTree();
      secondBlank.headers.event = "?";
      await act(async () => otherParse.resolve(secondBlank));
      expect(mocks.writeGame).toHaveBeenCalledOnce();
      expect(otherWorkspace.get(tabsAtom)[0]?.gameOrigin).toMatchObject({ gameNumber: 3 });
      expect(jotaiStore.get(tabsAtom)[0]?.gameOrigin).toMatchObject({ gameNumber: 1 });
      expect(independentStore.getState().headers.event).toBe("?");
      expect(treeStore.getState().headers.event).toBe("Keep this tree");
      expectPending();
      await act(async () => parse.resolve(defaultTree()));
      expect(mocks.writeGame).toHaveBeenCalledTimes(2);
      expect(getFileFreshness(tabId).state).toBe("verified");
      expect(getFileFreshness(otherId).state).toBe("verified");
    } finally {
      await act(async () => otherRoot.unmount());
      otherHost.remove();
      closeTreeStore(otherId);
      removeFileFreshness(otherId);
    }
  });
});
