import { useTabAtom, useOwnerTab, useOwnerTabId } from "@/state/tabScope";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { errorUnlessCancelled } from "@/platform/errors";
import { Menu, Paper, Portal, Stack, Tabs } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useHotkeys, useToggle, type HotkeyItem } from "@mantine/hooks";
import { GripVertical, NotebookPen, PanelTop, X } from "lucide-react";
import {
  AiChatIcon,
  AnalysisIcon,
  DatabaseIcon,
  GameInfoIcon,
  PracticeIcon,
  ReportIcon,
  ScoresheetPhotoIcon,
} from "@/components/common/iconCatalog";
import { parseUci, type Piece } from "chessops";
import { useAtom, useAtomValue, useStore as useAtomStore } from "jotai";
import {
  lazy,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { type StoreApi, useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { TreeStoreState } from "@/state/store/tree";
import {
  allEnabledFamily,
  autoSaveAtom,
  practiceTabFamily,
  reportModalOpenFamily,
  tabFamily,
  enableAllFamily,
  practiceMoveControllerFamily,
  practiceStateFamily,
  enginesAtom,
  threatFamily,
  tabEngineSettingsFamily,
  tabPreparationViewFamily,
} from "@/state/atoms";
import {
  engineIdFromArea,
  isPanelArea,
  PANEL_AREA_IDS,
  type PanelAreaId,
} from "@/state/boardArrangement";
import type { Engine } from "@/utils/engines";
import { selectStripTab } from "@/state/stripTab";
import { resolveBoardLayoutKind } from "@/state/boardLayoutKind";
import type { BoardLayoutKind } from "@/state/layoutPresets";
import { applyBoardLayoutToKind, boardLayoutListAtom } from "@/state/layoutStorage";
import { getVariationLine } from "@/utils/chess";
import { hasScoresheetPhotoPanel } from "@/utils/scoresheet";
import { positionFromFen } from "@/utils/chessops";
import { locateBoardState } from "@/utils/treeReducer";
import { withKeyboardOwnership } from "@/utils/keyboardOwnership";
import { readEngineLines } from "../panels/analysis/engineLines";
import { coachEnabledAtom } from "@/state/coach";
import { firedByNativeMenu, keyMapAtom } from "@/state/keybinds";
import type { Annotation } from "@/utils/annotation";
import {
  AddGameContext,
  getTabDestinationFile,
  getTabFile,
  isDraftGameOrigin,
  isPersistentGameOrigin,
  isRepertoireTab,
  saveToFile,
  useTabActions,
} from "@/utils/tabs";
import { applyGameNames } from "./gameNames";
import GameNameModal from "./GameNameModal";
import { useBoardCommands } from "./boardCommands";
import SaveToTargetModal from "./SaveToTargetModal";
import GameNotation from "../common/GameNotation";
import IconAction from "../common/IconAction";
import MoveControls from "../common/MoveControls";
import NotationColumn from "../common/NotationColumn";
import PanelArea from "./PanelArea";
import { TreeStateContext } from "../common/TreeStateContext";
import AnalysisPanel from "../panels/analysis/AnalysisPanel";
import BestMoves from "../panels/analysis/BestMoves";
import { notifyAnalysisPanelScroll } from "../panels/analysis/analysisPanelScroll";
import ReportPanel from "../panels/analysis/ReportPanel";
import AnnotationPanel from "../panels/annotation/AnnotationPanel";
import CoachPanel from "../panels/coach/CoachPanel";
import DatabasePanel from "../panels/database/DatabasePanel";
import InfoPanel from "../panels/info/InfoPanel";
import PracticePanel from "../panels/practice/PracticePanel";
import { RetryableLazyPanel } from "../common/PanelErrorBoundary";
import Board from "./Board";
import BoardControls from "./BoardControls";
import EditingCard from "./EditingCard";
import EvalListener from "./EvalListener";
import { useFileFreshness } from "@/state/fileFreshness";
import { requestFilePositionIndex } from "@/state/filePositionIndex";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import { FileChapterSwitchProvider } from "./FileChapterSwitch";
import { useAutoSave } from "./useAutoSave";
import ConfirmChangesModal from "@/components/tabs/ConfirmChangesModal";
import { useScaledMaxWidth } from "@/hooks/useScaledMaxWidth";
import paneClasses from "../common/PaneTabs.module.css";
import classes from "./BoardAnalysis.module.css";
import { COMPACT_PANE_TABS_WIDTH_EM } from "./paneTabs";
import { BoardArrangementContext } from "../tabs/BoardTabLayout";

const BoardLayoutModal = lazy(() => import("./BoardLayoutModal"));

/** Testable seam for the Photo panel's lazy chunk loader. */
export const scoresheetPhotoPanelLoader = {
  load: () => import("../panels/scoresheet/ScoresheetPhotoPanel"),
};

// Tree stores whose current autosave failure streak was already reported (see `saveFile`).
const autoSaveFailuresShown = new WeakSet<StoreApi<TreeStoreState>>();
// Tree stores whose last autosave write failed, kept on the store so Save stays visible across remounts.
const autoSaveFailedStores = new WeakSet<StoreApi<TreeStoreState>>();
const autoSaveFailureListeners = new WeakMap<StoreApi<TreeStoreState>, Set<() => void>>();

function subscribeAutoSaveFailure(store: StoreApi<TreeStoreState>, listener: () => void) {
  let listeners = autoSaveFailureListeners.get(store);
  if (!listeners) {
    listeners = new Set();
    autoSaveFailureListeners.set(store, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setAutoSaveFailed(store: StoreApi<TreeStoreState>, failed: boolean) {
  if (autoSaveFailedStores.has(store) === failed) return;
  if (failed) autoSaveFailedStores.add(store);
  else autoSaveFailedStores.delete(store);
  for (const listener of autoSaveFailureListeners.get(store) ?? []) {
    listener();
  }
}

/**
 * Owns the single file position index request for the mounted file-backed analysis tab, releasing
 * it on unmount, leaving the file, or verified-revision changes.
 */
function FilePositionIndexSync() {
  const [currentTab] = useOwnerTab();
  const tabId = useOwnerTabId();
  const tabFile = currentTab?.type === "analysis" ? getTabFile(currentTab) : undefined;
  const fileKey = tabFile ? fileWorkspaceKey(tabFile.handle) : null;
  const { verifiedRevision } = useFileFreshness(tabId);
  const tabFileRef = useRef(tabFile);
  tabFileRef.current = tabFile;

  useEffect(() => {
    const file = tabFileRef.current;
    if (!file || !fileKey || verifiedRevision === null) return;
    const { release } = requestFilePositionIndex(file, verifiedRevision);
    return release;
  }, [fileKey, verifiedRevision]);

  return null;
}

/**
 * Consumes a one-shot preparation landing once the chapter's tree is shown in `BoardAnalysis`.
 * Moves the cursor to the located position without touching the tree, or shows a notice when the
 * position is no longer in the chapter.
 */
function PreparationLandingConsumer() {
  const { t } = useTranslation();
  const [view, setView] = useAtom(useTabAtom(tabPreparationViewFamily));
  const store = useContext(TreeStateContext)!;
  const landing = view?.landing ?? null;

  useEffect(() => {
    if (!landing) return;
    const state = store.getState();
    const found = locateBoardState(state.root, landing.path, landing.boardState);
    if (found) {
      state.goToMove(found.position);
    } else {
      notifications.show({
        color: "warning",
        message: t("Databases.Preparation.PositionGone", {
          defaultValue: "This position is no longer in the chapter.",
        }),
      });
    }
    setView((current) => (current ? { ...current, landing: null } : current));
  }, [landing, setView, store, t]);

  return null;
}

/** A pulled-out engine window: one plain bordered tile whose scrolling body hosts `BestMoves`. */
function EngineWindowCard({
  engine,
  colorIndex,
  onReturn,
  onDragStart,
  onSuppressClick,
  onStartPlacing,
}: {
  engine: Engine;
  colorIndex: number;
  onReturn: () => void;
  onDragStart: (event: ReactPointerEvent<HTMLElement>) => void;
  onSuppressClick: (event: ReactMouseEvent) => void;
  onStartPlacing: () => void;
}) {
  const store = useContext(TreeStateContext)!;
  const rootFen = useStore(store, (s) => s.root.fen);
  const moves = useStore(
    store,
    useShallow((s) => getVariationLine(s.root, s.position)),
  );
  const halfMoves = useStore(store, (s) => s.currentNode().halfMoves);
  const orientation = useStore(store, (s) => s.headers.orientation || "white");

  return (
    <Paper
      withBorder
      className={classes.engineWindow}
      data-engine-window={engine.id}
      onScroll={notifyAnalysisPanelScroll}
    >
      <BestMoves
        id={colorIndex}
        engine={engine}
        fen={rootFen}
        moves={moves}
        halfMoves={halfMoves}
        orientation={orientation}
        mode="window"
        onReturn={onReturn}
        onDragStart={onDragStart}
        onSuppressClick={onSuppressClick}
        onStartPlacing={onStartPlacing}
      />
    </Paper>
  );
}

function BoardAnalysis() {
  const { t } = useTranslation();
  const compactTabs = useScaledMaxWidth(COMPACT_PANE_TABS_WIDTH_EM);
  const {
    shownPanelAreas,
    shownEngineAreas,
    getAreaTarget,
    arrangingAvailable,
    canTakeOut,
    returnPanel,
    returnEngine,
    registerReturnListener,
    beginDrag,
    consumeSuppressedClick,
    startPlacing,
    tabsHidden,
    setTabsHidden,
  } = useContext(BoardArrangementContext);

  const [editingMode, toggleEditingMode] = useToggle();
  const [selectedPiece, setSelectedPiece] = useState<Piece | null>(null);
  const [currentTab] = useOwnerTab();
  const atoms = useAtomStore();
  const tabId = useOwnerTabId();
  const { getTab, updateTab } = useTabActions();
  const [addGameConfirm, setAddGameConfirm] = useState(false);
  const tabFile = getTabFile(currentTab);
  const hasPersistentOrigin =
    !!currentTab && isPersistentGameOrigin(currentTab) && !isDraftGameOrigin(currentTab.gameOrigin);
  const [saveToModal, setSaveToModal] = useState(false);
  const [layoutModal, setLayoutModal] = useState<{
    mode: "save" | "manage";
    kind: BoardLayoutKind;
  } | null>(null);
  const autoSave = useAtomValue(autoSaveAtom);
  const engines = useAtomValue(enginesAtom);
  const loadedEngines = useMemo(() => (engines ?? []).filter((e) => e.loaded), [engines]);
  const boardRef = useRef(null);

  const store = useContext(TreeStateContext)!;

  const dirty = useStore(store, (s) => s.dirty);
  const autoSaveFailed = useSyncExternalStore(
    useCallback((listener) => subscribeAutoSaveFailure(store, listener), [store]),
    () => autoSaveFailedStores.has(store),
  );

  const setAnnotation = useStore(store, (s) => s.setAnnotation);

  const notifyError = useCallback(
    (error: unknown) => notifyUnlessCancelled(t("Common.Error"), error),
    [t],
  );

  // Autosave reports a failure streak once and surfaces Save until a clean tree or successful
  // save ends it. This effect resets both that notice and the failure flag when the tree is clean,
  // while `useAutoSave` below decides when to write. Both belong to the tab's store: a failed
  // write can remount this board, and the failure state must survive that.
  useEffect(() => {
    if (!dirty) {
      autoSaveFailuresShown.delete(store);
      setAutoSaveFailed(store, false);
    }
  }, [dirty, store]);
  const saveFile = useCallback(
    async (isUserSave = false) => {
      const result = await saveToFile({
        updateTab,
        getTab,
        tab: currentTab,
        store,
        isUserSave,
        skipIfClean: !isUserSave,
      });
      if (typeof result === "object" && result.status === "failed") {
        if (!isUserSave) setAutoSaveFailed(store, true);
        if (isUserSave || !autoSaveFailuresShown.has(store)) notifyError(result.error);
        if (!isUserSave && errorUnlessCancelled(result.error)) autoSaveFailuresShown.add(store);
      } else if (result === "saved" || !store.getState().dirty) {
        setAutoSaveFailed(store, false);
      } else if (isUserSave && result === "superseded") {
        notifyError({
          category: "validation",
          message: t("Tab.SaveSuperseded"),
        });
      } else if (
        isUserSave &&
        result === "conflict" &&
        currentTab &&
        getTab(currentTab.value)?.gameOrigin.kind !== "database" &&
        !getTabFile(getTab(currentTab.value))
      ) {
        // A Save As whose read-back failed leaves the tab without a file, so no freshness panel
        // can show the state; the destination may already hold the game.
        notifyError({
          category: "applied-despite-error",
          message: t("Tab.SaveMayHaveBeenWritten"),
        });
      }
    },
    [updateTab, getTab, currentTab, store, t, notifyError],
  );
  // A new game is named before its first save, so a user save of a draft only opens the naming
  // dialog and its confirmation writes; later saves write straight away.
  const [nameDialog, setNameDialog] = useState<"save" | "rename" | null>(null);
  const requestUserSave = useCallback(() => {
    const tab = currentTab && getTab(currentTab.value);
    if (tab && isDraftGameOrigin(tab.gameOrigin)) {
      setNameDialog("save");
      return;
    }
    void saveFile(true);
  }, [saveFile, currentTab, getTab]);
  // File and View menu commands: handled here so menus and in-board controls share one path.
  const openSaveTo = useCallback(() => setSaveToModal(true), []);
  const openSaveLayoutAs = useCallback(() => {
    setLayoutModal({ mode: "save", kind: resolveBoardLayoutKind(atoms, tabId) });
  }, [atoms, tabId]);
  const openManageLayouts = useCallback(() => {
    setLayoutModal({ mode: "manage", kind: resolveBoardLayoutKind(atoms, tabId) });
  }, [atoms, tabId]);
  const applyLayout = useCallback(
    (layoutId: string) => {
      applyBoardLayoutToKind(
        atoms,
        resolveBoardLayoutKind(atoms, tabId),
        layoutId,
        atoms.get(enginesAtom),
      );
    },
    [atoms, tabId],
  );
  useBoardCommands(currentTab?.value, {
    save: requestUserSave,
    saveTo: openSaveTo,
    saveLayoutAs: openSaveLayoutAs,
    manageLayouts: openManageLayouts,
  });
  useAutoSave(store, hasPersistentOrigin && autoSave, saveFile);

  const addGameAction = useContext(AddGameContext);
  const appendGame = useCallback(async () => {
    await addGameAction?.(currentTab);
  }, [addGameAction, currentTab]);
  const addGame = useCallback(() => {
    if (!tabFile || !currentTab) return;
    if (store.getState().dirty) {
      setAddGameConfirm(true);
      return;
    }
    void appendGame();
  }, [tabFile, currentTab, store, appendGame]);

  const [, enable] = useAtom(enableAllFamily(useOwnerTabId()));
  const allEnabled = useAtomValue(allEnabledFamily(useOwnerTabId()));

  const keyMap = useAtomValue(keyMapAtom);

  const [currentTabSelected, setCurrentTabSelected] = useAtom(useTabAtom(tabFamily));
  // A build without the Coach has no Coach tab, hotkey or panel. The Photo tab/panel exists while
  // a scoresheet review is active or the game carries a well-formed photo reference. Detached panel
  // areas leave the tab strip and render in their own tiles.
  const coachEnabled = useAtomValue(coachEnabledAtom);
  const hasScoresheetPhoto = useStore(store, (s) => hasScoresheetPhotoPanel(s));
  const isRepertoire = isRepertoireTab(currentTab);
  const isPanelAvailable = (panel: PanelAreaId) =>
    (panel !== "coach" || coachEnabled) && (panel !== "photo" || hasScoresheetPhoto);
  const panelMeta: Record<PanelAreaId, { title: string; Icon: typeof AnalysisIcon }> = {
    analysis: { title: t("Board.Tabs.Analysis"), Icon: AnalysisIcon },
    report: { title: t("Board.Analysis.Report"), Icon: ReportIcon },
    database: { title: t("Board.Tabs.Database"), Icon: DatabaseIcon },
    annotate: { title: t("Board.Tabs.Annotate"), Icon: NotebookPen },
    coach: { title: t("Board.Tabs.Coach"), Icon: AiChatIcon },
    photo: { title: t("Board.Tabs.Photo"), Icon: ScoresheetPhotoIcon },
    info: { title: t("Board.Tabs.Info"), Icon: GameInfoIcon },
  };
  const stripTabs = [
    ...(isRepertoire
      ? [{ value: "practice", title: t("Board.Tabs.Practice"), Icon: PracticeIcon }]
      : []),
    ...(!shownPanelAreas.has("analysis") ? [{ value: "analysis", ...panelMeta.analysis }] : []),
    ...(!shownPanelAreas.has("report") ? [{ value: "report", ...panelMeta.report }] : []),
    ...(!shownPanelAreas.has("database") ? [{ value: "database", ...panelMeta.database }] : []),
    ...(!shownPanelAreas.has("annotate") ? [{ value: "annotate", ...panelMeta.annotate }] : []),
    ...(coachEnabled && !shownPanelAreas.has("coach")
      ? [{ value: "coach", ...panelMeta.coach }]
      : []),
    ...(hasScoresheetPhoto && !shownPanelAreas.has("photo")
      ? [{ value: "photo", ...panelMeta.photo }]
      : []),
    ...(!shownPanelAreas.has("info") ? [{ value: "info", ...panelMeta.info }] : []),
  ];
  const stripTabIds = stripTabs.map((item) => item.value);
  // Fallback never shows Practice (keeps training mode aligned with the stored selection) and never
  // shows Photo (avoids loading the lazy scoresheet panel on fallback); stored selection is not rewritten.
  const shownTab = stripTabIds.includes(currentTabSelected)
    ? currentTabSelected
    : stripTabIds.includes("annotate")
      ? "annotate"
      : (stripTabIds.find((id) => id !== "practice" && id !== "photo") ?? "annotate");
  // A panel returning to a shown strip is selected. One returning to the hidden strip leaves the
  // selection on the tab that was last visible, so "Show tabs" shows that tab again.
  useEffect(() => {
    registerReturnListener((panel) => {
      if (!tabsHidden) setCurrentTabSelected(panel);
      else if (shownTab !== currentTabSelected) setCurrentTabSelected(shownTab);
    });
    return () => registerReturnListener(null);
  }, [registerReturnListener, setCurrentTabSelected, tabsHidden, shownTab, currentTabSelected]);
  const [, setReportModalOpen] = useAtom(useTabAtom(reportModalOpenFamily));
  const practiceTabSelected = useAtomValue(useTabAtom(practiceTabFamily));
  const destinationFile = getTabDestinationFile(currentTab);
  const headers = useStore(store, (s) => s.headers);
  const practicing = currentTabSelected === "practice" && practiceTabSelected === "train";
  const practiceState = useAtomValue(useTabAtom(practiceStateFamily));
  const practiceMoveController = useAtomValue(useTabAtom(practiceMoveControllerFamily));
  const selectInStrip = (tab: string) => selectStripTab(atoms, tabId, tab);

  useHotkeys(
    withKeyboardOwnership([
      [
        keyMap.PLAY_BEST_ENGINE_MOVE.keys,
        (event) => {
          if (event.defaultPrevented || practicing || editingMode || atoms.get(threatFamily(tabId)))
            return;
          const state = store.getState();
          const moves = getVariationLine(state.root, state.position);
          for (const engine of atoms.get(enginesAtom) ?? []) {
            const lines = readEngineLines(
              atoms.get,
              tabId,
              engine,
              state.root.fen,
              moves,
              false,
            ).actionable;
            const uci = lines?.find((line) => line.multipv === 1)?.uciMoves[0];
            if (!uci) continue;
            const move = parseUci(uci);
            const [position] = positionFromFen(state.currentNode().fen);
            if (!move || !position?.isLegal(move)) return;
            event.preventDefault();
            state.makeMove({ payload: move });
            return;
          }
        },
        { preventDefault: false },
      ],
      [
        keyMap.TOGGLE_THREAT_MODE.keys,
        (event) => {
          const threat = atoms.get(threatFamily(tabId));
          const enabled = (atoms.get(enginesAtom) ?? []).some(
            (engine) =>
              engine.loaded &&
              atoms.get(
                tabEngineSettingsFamily({
                  tab: tabId,
                  engineId: engine.id,
                }),
              ).enabled,
          );
          if (!threat && !enabled) return;
          atoms.set(threatFamily(tabId), !threat);
          event.preventDefault();
        },
        { preventDefault: false },
      ],
    ]),
  );

  const setPracticePath = useStore(store, (s) => s.setPracticePath);
  useEffect(() => {
    if (!practicing) {
      setPracticePath(null);
    }
  }, [practicing, setPracticePath]);

  useHotkeys(
    withKeyboardOwnership([
      ...(firedByNativeMenu("SAVE_FILE")
        ? []
        : [[keyMap.SAVE_FILE.keys, () => requestUserSave()] satisfies HotkeyItem]),
      [keyMap.UNDO.keys, () => store.getState().undo()],
      [keyMap.REDO.keys, () => store.getState().redo()],
    ]),
  );
  const annotate = (annotation: Annotation) => {
    if (!(practicing && practiceState.phase !== "idle")) setAnnotation(annotation);
  };
  useHotkeys(
    withKeyboardOwnership([
      ...(
        [
          [keyMap.ANNOTATION_BRILLIANT.keys, "!!"],
          [keyMap.ANNOTATION_GOOD.keys, "!"],
          [keyMap.ANNOTATION_INTERESTING.keys, "!?"],
          [keyMap.ANNOTATION_DUBIOUS.keys, "?!"],
          [keyMap.ANNOTATION_MISTAKE.keys, "?"],
          [keyMap.ANNOTATION_BLUNDER.keys, "??"],
        ] as const
      ).map<HotkeyItem>(([keys, annotation]) => [keys, () => annotate(annotation)]),
      [
        keyMap.PRACTICE_TAB.keys,
        () => {
          if (isRepertoire) selectInStrip("practice");
        },
      ],
      [
        keyMap.ANALYSIS_TAB.keys,
        () => {
          if (!shownPanelAreas.has("analysis")) selectInStrip("analysis");
        },
      ],
      [
        keyMap.GENERATE_REPORT.keys,
        (e) => {
          if (!shownPanelAreas.has("report")) selectInStrip("report");
          // Without moves, or while this tab runs a report, the shortcut only shows the tab.
          const { root, report } = store.getState();
          if (root.children.length > 0 && !report.inProgress) setReportModalOpen(true);
          e.preventDefault();
        },
      ],
      ...(
        [
          [keyMap.DATABASE_TAB.keys, "database"],
          [keyMap.ANNOTATE_TAB.keys, "annotate"],
          [keyMap.INFO_TAB.keys, "info"],
        ] as const
      ).map<HotkeyItem>(([keys, panel]) => [
        keys,
        () => {
          if (shownPanelAreas.has(panel)) return;
          selectInStrip(panel);
        },
      ]),
      ...(coachEnabled
        ? [
            [
              keyMap.COACH_TAB.keys,
              () => {
                if (!shownPanelAreas.has("coach")) selectInStrip("coach");
              },
            ] satisfies HotkeyItem,
          ]
        : []),
      [
        keyMap.TOGGLE_ALL_ENGINES.keys,
        (e) => {
          enable(!allEnabled);
          e.preventDefault();
        },
      ],
      ...(
        [
          [keyMap.APPLY_LAYOUT_1.keys, 0],
          [keyMap.APPLY_LAYOUT_2.keys, 1],
          [keyMap.APPLY_LAYOUT_3.keys, 2],
        ] as const
      ).map<HotkeyItem>(([keys, index]) => [
        keys,
        (e) => {
          const entry = atoms.get(boardLayoutListAtom)[index];
          if (!entry) return;
          const id = entry.kind === "preset" ? entry.preset.id : entry.saved.id;
          applyLayout(id);
          e.preventDefault();
        },
      ]),
    ]),
  );

  const panelContent: Record<PanelAreaId, () => ReactNode> = {
    analysis: () => <AnalysisPanel />,
    report: () => <ReportPanel />,
    database: () => <DatabasePanel />,
    annotate: () => <AnnotationPanel />,
    coach: () => <CoachPanel />,
    photo: () => (
      <RetryableLazyPanel
        load={() => scoresheetPhotoPanelLoader.load()}
        panelProps={{}}
        operation="scoresheet-photo-panel-load"
        logLabel="Scoresheet photo panel failed to load"
        loadFailedText={t("Scoresheet.LoadFailed")}
        retryLabel={t("Common.Retry")}
      />
    ),
    info: () => <InfoPanel addGame={addGame} />,
  };

  const takeOutPanels = PANEL_AREA_IDS.filter(
    (panel) => !shownPanelAreas.has(panel) && isPanelAvailable(panel) && canTakeOut(panel),
  );
  const tabList = (
    <Tabs.List grow={!compactTabs}>
      {stripTabs.map(({ value, title, Icon }) => {
        const panelId = arrangingAvailable && isPanelArea(value) ? value : null;
        const draggable = panelId !== null && canTakeOut(panelId);
        return (
          <Tabs.Tab
            key={value}
            value={value}
            leftSection={<Icon size="1rem" />}
            className={draggable ? classes.draggableTab : undefined}
            data-panel-tab={panelId ?? undefined}
            data-draggable-tab={draggable ? "true" : undefined}
            onPointerDown={draggable ? (e) => beginDrag(panelId, e) : undefined}
            onClickCapture={draggable ? consumeSuppressedClick : undefined}
          >
            {title}
          </Tabs.Tab>
        );
      })}
    </Tabs.List>
  );

  return (
    <FileChapterSwitchProvider>
      {nameDialog && (
        <GameNameModal
          opened
          onClose={() => setNameDialog(null)}
          headers={headers}
          repertoire={isRepertoire}
          title={
            nameDialog === "rename"
              ? t("GameNameModal.RenameLine")
              : isRepertoire
                ? t("GameNameModal.SaveLine")
                : t("GameNameModal.SaveGame")
          }
          confirmLabel={
            nameDialog === "rename"
              ? t("Files.Rename")
              : destinationFile
                ? t("GameNameModal.SaveTo", { target: destinationFile.name.replace(/\.pgn$/i, "") })
                : t("Common.Save")
          }
          onConfirm={(next) => {
            const saving = nameDialog === "save";
            setNameDialog(null);
            applyGameNames({ store, tab: currentTab, updateTab, next });
            if (saving) void saveFile(true);
          }}
        />
      )}
      {saveToModal && (
        <SaveToTargetModal
          opened
          onClose={() => setSaveToModal(false)}
          tab={currentTab}
          store={store}
        />
      )}
      {layoutModal && (
        <Suspense fallback={null}>
          <BoardLayoutModal
            opened
            mode={layoutModal.mode}
            kind={layoutModal.kind}
            onClose={() => setLayoutModal(null)}
          />
        </Suspense>
      )}
      <ConfirmChangesModal
        opened={addGameConfirm}
        toggle={() => setAddGameConfirm(false)}
        tab={currentTab}
        updateTab={updateTab}
        preserveChanges
        onSaved={() => {
          setAddGameConfirm(false);
          void appendGame();
        }}
      />
      <EvalListener />
      <FilePositionIndexSync />
      <PreparationLandingConsumer />
      <Portal target={getAreaTarget("left")} style={{ height: "100%" }}>
        <Paper withBorder h="100%" style={{ overflow: "hidden" }}>
          <Board
            repertoire={isRepertoire}
            onRenameLine={() => setNameDialog("rename")}
            practiceMove={practicing ? (practiceMoveController ?? undefined) : undefined}
            editingMode={editingMode}
            boardRef={boardRef}
            selectedPiece={selectedPiece}
            actions={
              <BoardControls
                boardRef={boardRef}
                editingMode={editingMode}
                toggleEditingMode={toggleEditingMode}
                dirty={dirty}
                saveFile={requestUserSave}
                autoSaveActive={hasPersistentOrigin && autoSave}
                autoSaveFailed={autoSaveFailed}
                saveTo={() => setSaveToModal(true)}
                onApplyLayout={applyLayout}
                onSaveLayoutAs={openSaveLayoutAs}
                onManageLayouts={openManageLayouts}
              />
            }
          />
        </Paper>
      </Portal>
      <Portal
        target={getAreaTarget("topRight")}
        className={paneClasses.root}
        style={{ height: "100%" }}
      >
        <Stack h="100%" gap="xs" className={paneClasses.root}>
          <Paper
            withBorder
            className={paneClasses.root}
            style={{
              flex: 1,
              overflow: "hidden",
            }}
            pos="relative"
          >
            <Tabs
              w="100%"
              h="100%"
              value={shownTab}
              onChange={(v) => setCurrentTabSelected(v || "info")}
              keepMounted={false}
              activateTabWithKeyboard={false}
              data-compact={compactTabs || undefined}
              classNames={{
                root: paneClasses.root,
                list: paneClasses.list,
                panel: paneClasses.panel,
                tab: paneClasses.tab,
                tabLabel: paneClasses.label,
              }}
              style={{
                display: "flex",
                flexDirection: "column",
              }}
              styles={{
                tab: {
                  display: "flex",
                  justifyContent: "center",
                  gap: "0.3rem",
                },
                panel: { flex: 1, overflowY: "hidden" },
              }}
            >
              {arrangingAvailable ? (
                <div className={classes.tabStripRow} data-board-tab-list="true">
                  {tabList}
                  <div className={classes.stripActions}>
                    <Menu position="bottom-end" shadow="md" withinPortal>
                      <Menu.Target>
                        <IconAction
                          label={t("Board.Arrange.MoveArea", { area: t("Board.Area.Tabs") })}
                          size="xs"
                          variant="subtle"
                          className={classes.grip}
                          data-arrange-grip="topRight"
                          onPointerDown={(e) => beginDrag("topRight", e)}
                          onClickCapture={consumeSuppressedClick}
                        >
                          <GripVertical size="0.875rem" />
                        </IconAction>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item onClick={() => startPlacing("topRight", "topRight")}>
                          {t("Board.Arrange.MoveTabs")}
                        </Menu.Item>
                        {takeOutPanels.map((panel) => {
                          const { title, Icon } = panelMeta[panel];
                          return (
                            <Menu.Item
                              key={panel}
                              leftSection={<Icon size="0.875rem" />}
                              onClick={() => startPlacing(panel, "topRight")}
                            >
                              {t("Board.Arrange.ShowAsArea", { panel: title })}
                            </Menu.Item>
                          );
                        })}
                      </Menu.Dropdown>
                    </Menu>
                    {/* Unmounted while hidden: its open tooltip must not outlive the hidden strip. */}
                    {!tabsHidden && (
                      <IconAction
                        label={t("Board.Area.HideTabs")}
                        size="xs"
                        variant="subtle"
                        data-hide-tabs="true"
                        onClick={() => setTabsHidden(true)}
                      >
                        <X size="0.875rem" />
                      </IconAction>
                    )}
                  </div>
                </div>
              ) : (
                tabList
              )}
              {isRepertoire && (
                <Tabs.Panel value="practice">
                  <PracticePanel />
                </Tabs.Panel>
              )}
              {PANEL_AREA_IDS.filter(
                (panel) => !shownPanelAreas.has(panel) && isPanelAvailable(panel),
              ).map((panel) => (
                <Tabs.Panel key={panel} value={panel}>
                  {panelContent[panel]()}
                </Tabs.Panel>
              ))}
            </Tabs>
          </Paper>
        </Stack>
      </Portal>
      {PANEL_AREA_IDS.filter((panel) => shownPanelAreas.has(panel) && isPanelAvailable(panel)).map(
        (panel) => {
          const { title, Icon } = panelMeta[panel];
          return (
            <Portal key={panel} target={getAreaTarget(panel)} style={{ height: "100%" }}>
              <PanelArea
                panel={panel}
                title={title}
                icon={<Icon size="1rem" />}
                onReturn={() => returnPanel(panel)}
                onDragStart={(e) => beginDrag(panel, e)}
                onSuppressClick={consumeSuppressedClick}
                onStartPlacing={() => startPlacing(panel)}
              >
                {panelContent[panel]()}
              </PanelArea>
            </Portal>
          );
        },
      )}
      {[...shownEngineAreas].map((engineArea) => {
        const engineId = engineIdFromArea(engineArea);
        const colorIndex = loadedEngines.findIndex((e) => e.id === engineId);
        if (colorIndex === -1) return null;
        const engine = loadedEngines[colorIndex];
        return (
          <Portal key={engineArea} target={getAreaTarget(engineArea)} style={{ height: "100%" }}>
            <EngineWindowCard
              engine={engine}
              colorIndex={colorIndex}
              onReturn={() => returnEngine(engineArea)}
              onDragStart={(e) => beginDrag(engineArea, e)}
              onSuppressClick={consumeSuppressedClick}
              onStartPlacing={() => startPlacing(engineArea)}
            />
          </Portal>
        );
      })}
      <Portal target={getAreaTarget("bottomRight")} style={{ height: "100%" }}>
        {editingMode ? (
          <EditingCard
            boardRef={boardRef}
            setEditingMode={toggleEditingMode}
            selectedPiece={selectedPiece}
            setSelectedPiece={setSelectedPiece}
          />
        ) : (
          <NotationColumn>
            <GameNotation
              topBar
              markOpenVariations
              arrange={
                arrangingAvailable
                  ? {
                      onDragStart: (e) => beginDrag("bottomRight", e),
                      onSuppressClick: consumeSuppressedClick,
                      onStartPlacing: () => startPlacing("bottomRight"),
                    }
                  : undefined
              }
              headerActions={
                arrangingAvailable && tabsHidden ? (
                  <IconAction
                    label={t("Board.Arrange.ShowTabs")}
                    size="sm"
                    variant="subtle"
                    data-show-tabs="true"
                    data-no-drag="true"
                    onClick={() => setTabsHidden(false)}
                  >
                    <PanelTop size="0.875rem" />
                  </IconAction>
                ) : undefined
              }
            />
            <MoveControls />
          </NotationColumn>
        )}
      </Portal>
    </FileChapterSwitchProvider>
  );
}

export default BoardAnalysis;
