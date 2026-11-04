import { useTabAtom, useOwnerTab, useOwnerTabId } from "@/state/tabScope";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { Paper, Portal, Tabs } from "@mantine/core";
import { useHotkeys, useToggle, type HotkeyItem } from "@mantine/hooks";
import { Database, Info, NotebookPen, Crosshair, ScanSearch } from "lucide-react";
import type { Piece } from "chessops";
import { useAtom, useAtomValue } from "jotai";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
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
} from "@/state/atoms";
import { keyMapAtom } from "@/state/keybinds";
import type { Annotation } from "@/utils/annotation";
import {
  AddGameContext,
  getTabFile,
  isPersistentGameOrigin,
  saveToFile,
  useTabActions,
} from "@/utils/tabs";
import SaveToDatabaseModal from "./SaveToDatabaseModal";
import DetachedEval from "../common/DetachedEval";
import GameNotation from "../common/GameNotation";
import MoveControls from "../common/MoveControls";
import NotationColumn from "../common/NotationColumn";
import { TreeStateContext } from "../common/TreeStateContext";
import AnalysisPanel from "../panels/analysis/AnalysisPanel";
import AnnotationPanel from "../panels/annotation/AnnotationPanel";
import DatabasePanel from "../panels/database/DatabasePanel";
import InfoPanel from "../panels/info/InfoPanel";
import PracticePanel from "../panels/practice/PracticePanel";
import Board from "./Board";
import BoardControls from "./BoardControls";
import EditingCard from "./EditingCard";
import EvalListener from "./EvalListener";
import ConfirmChangesModal from "@/components/tabs/ConfirmChangesModal";
import { useScaledMaxWidth } from "@/hooks/useScaledMaxWidth";
import paneClasses from "../common/PaneTabs.module.css";
import { COMPACT_PANE_TABS_WIDTH_EM } from "./paneTabs";

function BoardAnalysis() {
  const { t } = useTranslation();
  const compactTabs = useScaledMaxWidth(COMPACT_PANE_TABS_WIDTH_EM);

  const [editingMode, toggleEditingMode] = useToggle();
  const [selectedPiece, setSelectedPiece] = useState<Piece | null>(null);
  const [currentTab] = useOwnerTab();
  const { getTab, updateTab } = useTabActions();
  const [addGameConfirm, setAddGameConfirm] = useState(false);
  const tabFile = getTabFile(currentTab);
  const hasPersistentOrigin =
    isPersistentGameOrigin(currentTab) && currentTab?.gameOrigin.kind !== "databaseDraft";
  const [databaseModal, setDatabaseModal] = useState(false);
  const autoSave = useAtomValue(autoSaveAtom);
  const boardRef = useRef(null);

  const store = useContext(TreeStateContext)!;

  const dirty = useStore(store, (s) => s.dirty);

  const clearShapes = useStore(store, (s) => s.clearShapes);
  const setAnnotation = useStore(store, (s) => s.setAnnotation);

  const notifyError = useCallback(
    (error: unknown) => notifyUnlessCancelled(t("Common.Error"), error),
    [t],
  );

  const saveFile = useCallback(
    async (isUserSave = false) => {
      const result = await saveToFile({
        updateTab,
        getTab,
        tab: currentTab,
        store,
        isUserSave,
      });
      if (typeof result === "object" && result.status === "failed") {
        notifyError(result.error);
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
  const userSaveFile = useCallback(() => saveFile(true), [saveFile]);
  useEffect(() => {
    if (hasPersistentOrigin && autoSave && dirty) {
      saveFile();
    }
  }, [hasPersistentOrigin, saveFile, autoSave, dirty]);

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
  const [, setReportModalOpen] = useAtom(useTabAtom(reportModalOpenFamily));
  const practiceTabSelected = useAtomValue(useTabAtom(practiceTabFamily));
  const isRepertoire = tabFile?.metadata.type === "repertoire";
  const practicing = currentTabSelected === "practice" && practiceTabSelected === "train";
  const practiceState = useAtomValue(useTabAtom(practiceStateFamily));
  const practiceMoveController = useAtomValue(useTabAtom(practiceMoveControllerFamily));
  const isPracticeRating = practicing && practiceState.phase === "correct";

  const setPracticePath = useStore(store, (s) => s.setPracticePath);
  useEffect(() => {
    if (!practicing) {
      setPracticePath(null);
    }
  }, [practicing, setPracticePath]);

  useHotkeys([
    [keyMap.SAVE_FILE.keys, () => userSaveFile()],
    [keyMap.CLEAR_SHAPES.keys, () => clearShapes()],
  ]);
  const annotate = (annotation: Annotation) => {
    if (!isPracticeRating) setAnnotation(annotation);
  };
  useHotkeys([
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
        setReportModalOpen(true);
        e.preventDefault();
      },
    ],
    ...(
      [
        [keyMap.DATABASE_TAB.keys, "database"],
        [keyMap.ANNOTATE_TAB.keys, "annotate"],
        [keyMap.INFO_TAB.keys, "info"],
      ] as const
    ).map<HotkeyItem>(([keys, panel]) => [keys, () => setCurrentTabSelected(panel)]),
    [
      keyMap.TOGGLE_ALL_ENGINES.keys,
      (e) => {
        enable(!allEnabled);
        e.preventDefault();
      },
    ],
  ]);

  return (
    <>
      {databaseModal && (
        <SaveToDatabaseModal
          opened
          onClose={() => setDatabaseModal(false)}
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
      <Portal target="#left" style={{ height: "100%" }}>
        <Paper withBorder h="100%" style={{ overflow: "hidden" }}>
          <Board
            practiceMove={practicing ? (practiceMoveController ?? undefined) : undefined}
            editingMode={editingMode}
            boardRef={boardRef}
            selectedPiece={selectedPiece}
          />
        </Paper>
      </Portal>
      <Portal target="#topRight" className={paneClasses.root} style={{ height: "100%" }}>
        <Paper
          withBorder
          className={paneClasses.root}
          style={{
            height: "100%",
            overflow: "hidden",
          }}
          pos="relative"
        >
          <Tabs
            w="100%"
            h="100%"
            value={currentTabSelected}
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
                  ? [{ value: "practice", title: t("Board.Tabs.Practice"), Icon: Crosshair }]
                  : []),
                { value: "analysis", title: t("Board.Tabs.Analysis"), Icon: ScanSearch },
                { value: "database", title: t("Board.Tabs.Database"), Icon: Database },
                { value: "annotate", title: t("Board.Tabs.Annotate"), Icon: NotebookPen },
                { value: "info", title: t("Board.Tabs.Info"), Icon: Info },
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
            <Tabs.Panel value="database">
              <DatabasePanel />
            </Tabs.Panel>
            <Tabs.Panel value="annotate">
              <AnnotationPanel />
            </Tabs.Panel>
            <Tabs.Panel value="analysis">
              <AnalysisPanel />
            </Tabs.Panel>
          </Tabs>
        </Paper>
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
            <DetachedEval />
            <GameNotation
              topBar
              controls={
                <BoardControls
                  editingMode={editingMode}
                  toggleEditingMode={toggleEditingMode}
                  dirty={dirty}
                  saveFile={userSaveFile}
                  saveDatabase={() => setDatabaseModal(true)}
                />
              }
            />
            <MoveControls />
          </NotationColumn>
        )}
      </Portal>
    </>
  );
}

export default BoardAnalysis;
