import { useOwnerTab } from "@/state/tabScope";
import { Stack } from "@mantine/core";
import {
  Undo2,
  Redo2,
  Camera,
  Save,
  Database,
  Pencil,
  PencilOff,
  Eraser,
  ArrowUpDown,
  Target,
  ScanSearch,
} from "lucide-react";
import { tauri } from "@/platform/tauri";
import domtoimage from "dom-to-image";
import { useAtomValue } from "jotai";
import { memo, useContext } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import IconAction from "@/components/common/IconAction";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { autoSaveAtom, eraseDrawablesOnClickAtom } from "@/state/atoms";
import { keyMapAtom } from "@/state/keybinds";
import { formatKeymap } from "@/utils/formatKeymap";
import { usePlayFromHere } from "./usePlayFromHere";

interface BoardControlsProps {
  boardRef: React.RefObject<HTMLDivElement | null>;
  editingMode: boolean;
  toggleEditingMode: () => void;
  dirty: boolean;
  saveFile?: () => void;
  saveTo?: () => void;
  canTakeBack?: boolean;
  onTakeBack?: () => void;
  takeBackPending?: boolean;
  disableVariations?: boolean;
  allowEditing?: boolean;
  /** Shows undo and redo of the game's edits. */
  allowUndo?: boolean;
}

function BoardControls({
  boardRef,
  editingMode,
  toggleEditingMode,
  dirty,
  saveFile,
  saveTo,
  canTakeBack,
  onTakeBack,
  takeBackPending,
  disableVariations,
  allowEditing,
  allowUndo,
}: BoardControlsProps) {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const headers = useStore(store, (s) => s.headers);
  const root = useStore(store, (s) => s.root);
  const position = useStore(store, (s) => s.position);
  const setHeaders = useStore(store, (s) => s.setHeaders);
  const clearShapes = useStore(store, (s) => s.clearShapes);
  const canUndo = useStore(store, (s) => s.history.past.length > 0 && s.practicePath === null);
  const canRedo = useStore(store, (s) => s.history.future.length > 0 && s.practicePath === null);
  const undo = useStore(store, (s) => s.undo);
  const redo = useStore(store, (s) => s.redo);

  const keyMap = useAtomValue(keyMapAtom);
  const [currentTab, setCurrentTab] = useOwnerTab();
  const autoSave = useAtomValue(autoSaveAtom);
  const eraseDrawablesOnClick = useAtomValue(eraseDrawablesOnClickAtom);
  const playFromHere = usePlayFromHere();

  const orientation = headers.orientation || "white";
  const toggleOrientation = () =>
    setHeaders({
      ...headers,
      fen: root.fen,
      orientation: orientation === "black" ? "white" : "black",
    });

  function playFromHereOrAnalyze() {
    if (currentTab?.type === "analysis") {
      playFromHere(root, headers.orientation, position);
      return;
    }
    setCurrentTab((tab) => ({
      ...tab,
      type: "analysis",
    }));
  }

  const takeSnapshot = async () => {
    const snapshotTarget = boardRef.current?.querySelector<HTMLElement>(".cg-wrap") ?? null;
    if (!snapshotTarget) return;

    try {
      const blob = await domtoimage.toBlob(snapshotTarget);
      if (blob == null) return;

      const arrayBuffer = await blob.arrayBuffer();
      await tauri.saveBoardSnapshot(Array.from(new Uint8Array(arrayBuffer)));
    } catch (error) {
      notifyUnlessCancelled(t("Common.Error"), error);
    }
  };

  return (
    <Stack gap={4} align="center">
      <IconAction label={t("Board.Action.TakeSnapshot")} onClick={() => takeSnapshot()}>
        <Camera size="1.2rem" />
      </IconAction>
      {canTakeBack && onTakeBack && (
        <IconAction
          label={t("Board.Action.TakeBack", { defaultValue: "Take back" })}
          onClick={() => onTakeBack()}
          pending={takeBackPending}
        >
          <Undo2 />
        </IconAction>
      )}
      {allowUndo && (
        <>
          <IconAction
            label={t("Board.Action.Undo", { key: formatKeymap(keyMap.UNDO.keys) })}
            onClick={() => undo()}
            disabled={!canUndo}
          >
            <Undo2 size="1.2rem" />
          </IconAction>
          <IconAction
            label={t("Board.Action.Redo", { key: formatKeymap(keyMap.REDO.keys) })}
            onClick={() => redo()}
            disabled={!canRedo}
          >
            <Redo2 size="1.2rem" />
          </IconAction>
        </>
      )}
      <IconAction
        label={t(
          currentTab?.type === "analysis"
            ? "Board.Action.PlayFromHere"
            : "Board.Action.AnalyzeGame",
        )}
        onClick={playFromHereOrAnalyze}
      >
        {currentTab?.type === "analysis" ? <Target size="1.2rem" /> : <ScanSearch size="1.2rem" />}
      </IconAction>
      {!eraseDrawablesOnClick && (
        <IconAction label={t("Board.Action.ClearDrawings")} onClick={() => clearShapes()}>
          <Eraser size="1.2rem" />
        </IconAction>
      )}
      {(!disableVariations || allowEditing) && (
        <IconAction
          label={t("Board.Action.EditPosition")}
          onClick={() => toggleEditingMode()}
          pressed={editingMode}
        >
          {editingMode ? <PencilOff size="1.2rem" /> : <Pencil size="1.2rem" />}
        </IconAction>
      )}

      {saveFile && (
        <IconAction
          label={t("Board.Action.SavePGN", { key: formatKeymap(keyMap.SAVE_FILE.keys) })}
          onClick={() => saveFile()}
          variant={dirty && !autoSave ? "default" : "transparent"}
        >
          <Save size="1.2rem" />
        </IconAction>
      )}
      {saveTo && (
        <IconAction label={t("Board.Database.Save")} onClick={saveTo}>
          <Database size="1.2rem" />
        </IconAction>
      )}
      <IconAction
        label={t("Board.Action.FlipBoard", {
          key: formatKeymap(keyMap.SWAP_ORIENTATION.keys),
        })}
        onClick={() => toggleOrientation()}
      >
        <ArrowUpDown size="1.2rem" />
      </IconAction>
    </Stack>
  );
}

export default memo(BoardControls);
