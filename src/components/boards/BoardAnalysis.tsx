import { useTabAtom, useOwnerTab, useOwnerTabId } from "@/state/tabScope";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { errorUnlessCancelled } from "@/platform/errors";
import { Paper, Portal, Stack, Tabs } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useElementSize, useHotkeys, useToggle, type HotkeyItem } from "@mantine/hooks";
import { NotebookPen } from "lucide-react";
import {
  AiChatIcon,
  AnalysisIcon,
  DatabaseIcon,
  GameInfoIcon,
  PracticeIcon,
} from "@/components/common/iconCatalog";
import { parseUci, type Piece } from "chessops";
import { useAtom, useAtomValue, useStore as useAtomStore } from "jotai";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type StoreApi, useStore } from "zustand";
import type { TreeStoreState } from "@/state/store/tree";
import {
  allEnabledFamily,
  autoSaveAtom,
  analysisTabFamily,
  practiceTabFamily,
  reportModalOpenFamily,
  tabFamily,
  enableAllFamily,
  practiceMoveControllerFamily,
  practiceStateFamily,
  enginesAtom,
  explorerDetachedAtom,
  threatFamily,
  tabEngineSettingsFamily,
  tabPreparationViewFamily,
} from "@/state/atoms";
import { getVariationLine } from "@/utils/chess";
import { positionFromFen } from "@/utils/chessops";
import { locateBoardState } from "@/utils/treeReducer";
import { withKeyboardOwnership } from "@/utils/keyboardOwnership";
import { readEngineLines } from "../panels/analysis/engineLines";
import { coachEnabledAtom } from "@/state/coach";
import { keyMapAtom } from "@/state/keybinds";
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
import DetachedEval from "./DetachedEval";
import GameNotation from "../common/GameNotation";
import MoveControls from "../common/MoveControls";
import NotationColumn from "../common/NotationColumn";
import PinnedExplorer from "./PinnedExplorer";
import { TreeStateContext } from "../common/TreeStateContext";
import AnalysisPanel from "../panels/analysis/AnalysisPanel";
import AnnotationPanel from "../panels/annotation/AnnotationPanel";
import CoachPanel from "../panels/coach/CoachPanel";
import DatabasePanel from "../panels/database/DatabasePanel";
import InfoPanel from "../panels/info/InfoPanel";
import PracticePanel from "../panels/practice/PracticePanel";
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
import { BoardLayoutModeContext } from "@/state/paneLayout";

/**
 * Owns the single file position index request for the mounted file-backed analysis tab, releasing
 * it on unmount, leaving the file, or verified-revision changes.
 */
// Tree stores whose current autosave failure streak was already reported (see `saveFile`).
const autoSaveFailuresShown = new WeakSet<StoreApi<TreeStoreState>>();

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

function BoardAnalysis() {
  const { t } = useTranslation();
  const compactTabs = useScaledMaxWidth(COMPACT_PANE_TABS_WIDTH_EM);
  // With the panels beside the notation, what is pinned above the tabs spans both.
  const panelsBeside = useContext(BoardLayoutModeContext) === "beside";
  const aboveTabs = (
    <>
      <DetachedEval placement="tabs" />
      <PinnedExplorer placement="tabs" />
    </>
  );

  const [editingMode, toggleEditingMode] = useToggle();
  const [selectedPiece, setSelectedPiece] = useState<Piece | null>(null);
  const [currentTab] = useOwnerTab();
  const { getTab, updateTab } = useTabActions();
  const [addGameConfirm, setAddGameConfirm] = useState(false);
  const tabFile = getTabFile(currentTab);
  const hasPersistentOrigin =
    !!currentTab && isPersistentGameOrigin(currentTab) && !isDraftGameOrigin(currentTab.gameOrigin);
  const [saveToModal, setSaveToModal] = useState(false);
  const autoSave = useAtomValue(autoSaveAtom);
  const boardRef = useRef(null);
  // The explorer strip and engine bar below the board: the board gives up their rendered height.
  const { ref: belowBoardRef, height: belowBoardHeight } = useElementSize<HTMLDivElement>();

  const store = useContext(TreeStateContext)!;

  const dirty = useStore(store, (s) => s.dirty);

  const clearShapes = useStore(store, (s) => s.clearShapes);
  const setAnnotation = useStore(store, (s) => s.setAnnotation);

  const notifyError = useCallback(
    (error: unknown) => notifyUnlessCancelled(t("Common.Error"), error),
    [t],
  );

  // Autosave reports a failure streak once; a clean tree ends the streak. This effect only
  // resets that notice, `useAutoSave` below decides when to write. The streak belongs to the
  // tab's store: a failed write can remount this board, and the streak must survive that.
  useEffect(() => {
    if (!dirty) autoSaveFailuresShown.delete(store);
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
        if (isUserSave || !autoSaveFailuresShown.has(store)) notifyError(result.error);
        if (!isUserSave && errorUnlessCancelled(result.error)) autoSaveFailuresShown.add(store);
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
  // File menu → Save / Save to…: handled here, Save through the board controls' own handler.
  const openSaveTo = useCallback(() => setSaveToModal(true), []);
  useBoardCommands(currentTab?.value, { save: requestUserSave, saveTo: openSaveTo });
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

  const [, setAnalysisTab] = useAtom(useTabAtom(analysisTabFamily));
  const [currentTabSelected, setCurrentTabSelected] = useAtom(useTabAtom(tabFamily));
  // Pinned, the explorer is a strip in its chosen place and no longer one of the tabs. A tab whose stored
  // choice is the explorer shows Annotate meanwhile; the stored choice is left alone.
  const explorerDetached = useAtomValue(explorerDetachedAtom);
  // A build without the Coach has no Coach tab, hotkey or panel; a stored choice of it shows
  // Annotate, like the pinned explorer's.
  const coachEnabled = useAtomValue(coachEnabledAtom);
  const shownTab =
    (explorerDetached && currentTabSelected === "database") ||
    (!coachEnabled && currentTabSelected === "coach")
      ? "annotate"
      : currentTabSelected;
  const [, setReportModalOpen] = useAtom(useTabAtom(reportModalOpenFamily));
  const practiceTabSelected = useAtomValue(useTabAtom(practiceTabFamily));
  const isRepertoire = isRepertoireTab(currentTab);
  const destinationFile = getTabDestinationFile(currentTab);
  const headers = useStore(store, (s) => s.headers);
  const practicing = currentTabSelected === "practice" && practiceTabSelected === "train";
  const practiceState = useAtomValue(useTabAtom(practiceStateFamily));
  const practiceMoveController = useAtomValue(useTabAtom(practiceMoveControllerFamily));
  const atoms = useAtomStore();
  const tabId = useOwnerTabId();

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
      [keyMap.SAVE_FILE.keys, () => requestUserSave()],
      [keyMap.CLEAR_SHAPES.keys, () => clearShapes()],
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
          if (isRepertoire) setCurrentTabSelected("practice");
        },
      ],
      [keyMap.ANALYSIS_TAB.keys, () => setCurrentTabSelected("analysis")],
      [
        keyMap.GENERATE_REPORT.keys,
        (e) => {
          setCurrentTabSelected("analysis");
          setAnalysisTab("report");
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
          if (panel === "database" && explorerDetached) return;
          setCurrentTabSelected(panel);
        },
      ]),
      ...(coachEnabled
        ? [[keyMap.COACH_TAB.keys, () => setCurrentTabSelected("coach")] satisfies HotkeyItem]
        : []),
      [
        keyMap.TOGGLE_ALL_ENGINES.keys,
        (e) => {
          enable(!allEnabled);
          e.preventDefault();
        },
      ],
    ]),
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
      <Portal target="#left" style={{ height: "100%" }}>
        <Stack
          h="100%"
          gap="xs"
          data-pinned-pane
          data-pinned-pane-grows
          style={{
            "--board-below-height":
              belowBoardHeight > 0
                ? `calc(${belowBoardHeight}px + var(--mantine-spacing-xs))`
                : undefined,
          }}
        >
          <Paper withBorder style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
            <Board
              repertoire={isRepertoire}
              onRenameLine={() => setNameDialog("rename")}
              practiceMove={practicing ? (practiceMoveController ?? undefined) : undefined}
              editingMode={editingMode}
              boardRef={boardRef}
              selectedPiece={selectedPiece}
            />
          </Paper>
          <div ref={belowBoardRef} className={classes.belowBoard} data-slot="below-board">
            <PinnedExplorer placement="board" />
            <DetachedEval placement="board" />
          </div>
        </Stack>
      </Portal>
      {/* `#rightSpan` is the slot across the notation and the panels, `#topRight` the panels. */}
      {panelsBeside && (
        <Portal target="#rightSpan" className={classes.spanSlot}>
          {aboveTabs}
        </Portal>
      )}
      <Portal target="#topRight" className={paneClasses.root} style={{ height: "100%" }}>
        <Stack h="100%" gap="xs" className={paneClasses.root} data-pinned-pane>
          {!panelsBeside && aboveTabs}
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
              <Tabs.List grow={!compactTabs}>
                {[
                  ...(isRepertoire
                    ? [{ value: "practice", title: t("Board.Tabs.Practice"), Icon: PracticeIcon }]
                    : []),
                  { value: "analysis", title: t("Board.Tabs.Analysis"), Icon: AnalysisIcon },
                  ...(explorerDetached
                    ? []
                    : [{ value: "database", title: t("Board.Tabs.Database"), Icon: DatabaseIcon }]),
                  { value: "annotate", title: t("Board.Tabs.Annotate"), Icon: NotebookPen },
                  ...(coachEnabled
                    ? [{ value: "coach", title: t("Board.Tabs.Coach"), Icon: AiChatIcon }]
                    : []),
                  { value: "info", title: t("Board.Tabs.Info"), Icon: GameInfoIcon },
                ].map(({ value, title, Icon }) => (
                  <Tabs.Tab key={value} value={value} leftSection={<Icon size="1rem" />}>
                    {title}
                  </Tabs.Tab>
                ))}
              </Tabs.List>
              {isRepertoire && (
                <Tabs.Panel value="practice">
                  <PracticePanel />
                </Tabs.Panel>
              )}
              <Tabs.Panel value="info">
                <InfoPanel addGame={addGame} />
              </Tabs.Panel>
              {!explorerDetached && (
                <Tabs.Panel value="database">
                  <DatabasePanel />
                </Tabs.Panel>
              )}
              <Tabs.Panel value="annotate">
                <AnnotationPanel />
              </Tabs.Panel>
              {coachEnabled && (
                <Tabs.Panel value="coach">
                  <CoachPanel />
                </Tabs.Panel>
              )}
              <Tabs.Panel value="analysis">
                <AnalysisPanel />
              </Tabs.Panel>
            </Tabs>
          </Paper>
        </Stack>
      </Portal>
      <Portal target="#bottomRight" style={{ height: "100%" }}>
        {editingMode ? (
          <EditingCard
            boardRef={boardRef}
            setEditingMode={toggleEditingMode}
            selectedPiece={selectedPiece}
            setSelectedPiece={setSelectedPiece}
          />
        ) : (
          <NotationColumn>
            <DetachedEval placement="notation" />
            <PinnedExplorer placement="notation" />
            <GameNotation
              topBar
              markOpenVariations
              controls={
                <BoardControls
                  boardRef={boardRef}
                  editingMode={editingMode}
                  toggleEditingMode={toggleEditingMode}
                  dirty={dirty}
                  saveFile={requestUserSave}
                  saveTo={() => setSaveToModal(true)}
                  allowUndo
                />
              }
            />
            <MoveControls />
            <PinnedExplorer placement="belowNotation" />
            <DetachedEval placement="belowNotation" />
          </NotationColumn>
        )}
      </Portal>
    </FileChapterSwitchProvider>
  );
}

export default BoardAnalysis;
