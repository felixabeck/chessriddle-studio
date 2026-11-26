import { useOwnerTab } from "@/state/tabScope";
import { Group, Menu, Text } from "@mantine/core";
import {
  Undo2,
  BookmarkPlus,
  Camera,
  Check,
  Save,
  Database,
  Ellipsis,
  LayoutGrid,
  PanelTop,
  Pencil,
  PencilOff,
  ArrowUpDown,
  Target,
  ScanSearch,
  SquarePlus,
} from "lucide-react";
import { tauri } from "@/platform/tauri";
import domtoimage from "dom-to-image";
import { useAtomValue } from "jotai";
import { memo, useContext, useRef } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import IconAction from "@/components/common/IconAction";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { keyMapAtom } from "@/state/keybinds";
import { boardLayoutListAtom } from "@/state/layoutStorage";
import { formatKeymap } from "@/utils/formatKeymap";
import { backgroundHotkeyOptions } from "@/utils/keyboardOwnership";
import { useTabCommands } from "@/components/tabs/TabCommands";
import { usePlayFromHere } from "./usePlayFromHere";

interface BoardControlsProps {
  boardRef: React.RefObject<HTMLDivElement | null>;
  editingMode: boolean;
  toggleEditingMode: () => void;
  dirty: boolean;
  saveFile?: () => void;
  autoSaveActive?: boolean;
  autoSaveFailed?: boolean;
  saveTo?: () => void;
  canTakeBack?: boolean;
  onTakeBack?: () => void;
  takeBackPending?: boolean;
  disableVariations?: boolean;
  allowEditing?: boolean;
  onApplyLayout?: (layoutId: string) => void;
  onSaveLayoutAs?: () => void;
  onManageLayouts?: () => void;
  /** Present only while the analysis board's tab strip is hidden. */
  onShowTabs?: () => void;
}

function BoardControls({
  boardRef,
  editingMode,
  toggleEditingMode,
  dirty,
  saveFile,
  autoSaveActive = false,
  autoSaveFailed = false,
  saveTo,
  canTakeBack,
  onTakeBack,
  takeBackPending,
  disableVariations,
  allowEditing,
  onApplyLayout,
  onSaveLayoutAs,
  onManageLayouts,
  onShowTabs,
}: BoardControlsProps) {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const headers = useStore(store, (s) => s.headers);
  const root = useStore(store, (s) => s.root);
  const position = useStore(store, (s) => s.position);
  const setHeaders = useStore(store, (s) => s.setHeaders);

  const keyMap = useAtomValue(keyMapAtom);
  const layoutList = useAtomValue(boardLayoutListAtom);
  const [currentTab, setCurrentTab] = useOwnerTab();
  const playFromHere = usePlayFromHere();
  const { newAnalysis } = useTabCommands();
  const isAnalysis = currentTab?.type === "analysis";
  const snapshotInFlightRef = useRef(false);

  const orientation = headers.orientation || "white";
  const toggleOrientation = () =>
    setHeaders({
      ...headers,
      fen: root.fen,
      orientation: orientation === "black" ? "white" : "black",
    });

  function playFromHereOrAnalyze() {
    if (isAnalysis) {
      playFromHere(root, headers.orientation, position);
      return;
    }
    setCurrentTab((tab) => ({
      ...tab,
      type: "analysis",
    }));
  }

  const takeSnapshot = async () => {
    if (snapshotInFlightRef.current) return;
    const snapshotTarget = boardRef.current?.querySelector<HTMLElement>(".cg-wrap") ?? null;
    if (!snapshotTarget) return;

    snapshotInFlightRef.current = true;
    try {
      const blob = await domtoimage.toBlob(snapshotTarget);
      if (blob == null) return;

      const arrayBuffer = await blob.arrayBuffer();
      await tauri.saveBoardSnapshot(Array.from(new Uint8Array(arrayBuffer)));
    } catch (error) {
      notifyUnlessCancelled(t("Common.Error"), error);
    } finally {
      snapshotInFlightRef.current = false;
    }
  };

  const canEdit = !disableVariations || Boolean(allowEditing);
  const showSave = Boolean(saveFile && dirty && (!autoSaveActive || autoSaveFailed));
  const showLayouts =
    currentTab?.type === "analysis" && Boolean(onApplyLayout && onSaveLayoutAs && onManageLayouts);

  useHotkeys(keyMap.EDIT_POSITION.keys, () => toggleEditingMode(), {
    ...backgroundHotkeyOptions,
    enabled: canEdit,
    preventDefault: true,
  });
  useHotkeys(
    keyMap.TAKE_SNAPSHOT.keys,
    () => {
      void takeSnapshot();
    },
    {
      ...backgroundHotkeyOptions,
      preventDefault: true,
    },
  );
  useHotkeys(keyMap.SAVE_TO_DATABASE.keys, () => saveTo?.(), {
    ...backgroundHotkeyOptions,
    enabled: Boolean(saveTo),
    preventDefault: true,
  });

  return (
    <Group gap={4} wrap="nowrap" data-no-drag="true">
      {canTakeBack && onTakeBack && (
        <IconAction
          label={t("Board.Action.TakeBack", { defaultValue: "Take back" })}
          size="sm"
          variant="subtle"
          onClick={() => onTakeBack()}
          pending={takeBackPending}
        >
          <Undo2 size="1rem" />
        </IconAction>
      )}
      <IconAction
        label={t(isAnalysis ? "Board.Action.PlayFromHere" : "Board.Action.AnalyzeGame")}
        size="sm"
        variant="subtle"
        onClick={playFromHereOrAnalyze}
      >
        {isAnalysis ? <Target size="1rem" /> : <ScanSearch size="1rem" />}
      </IconAction>
      <IconAction
        label={t("Board.Action.FlipBoard", {
          key: formatKeymap(keyMap.SWAP_ORIENTATION.keys),
        })}
        size="sm"
        variant="subtle"
        onClick={() => toggleOrientation()}
      >
        <ArrowUpDown size="1rem" />
      </IconAction>
      {showSave && saveFile && (
        <IconAction
          label={t("Board.Action.SavePGN", { key: formatKeymap(keyMap.SAVE_FILE.keys) })}
          size="sm"
          variant="default"
          onClick={() => saveFile()}
        >
          <Save size="1rem" />
        </IconAction>
      )}
      <Menu position="bottom-end" shadow="md" withinPortal>
        <Menu.Target>
          <IconAction label={t("Board.Action.More")} size="sm" variant="subtle" data-no-drag="true">
            <Ellipsis size="1rem" />
          </IconAction>
        </Menu.Target>
        <Menu.Dropdown>
          {isAnalysis && (
            <>
              <Menu.Item
                leftSection={<SquarePlus size="0.875rem" />}
                rightSection={
                  <Text size="xs" c="dimmed">
                    {formatKeymap(keyMap.NEW_ANALYSIS.keys)}
                  </Text>
                }
                onClick={newAnalysis}
              >
                {t("Board.Action.NewAnalysis")}
              </Menu.Item>
              <Menu.Divider />
            </>
          )}
          {saveTo && (
            <Menu.Item
              leftSection={<Database size="0.875rem" />}
              rightSection={
                <Text size="xs" c="dimmed">
                  {formatKeymap(keyMap.SAVE_TO_DATABASE.keys)}
                </Text>
              }
              onClick={saveTo}
            >
              {t("Board.Database.Save")}
            </Menu.Item>
          )}
          <Menu.Item
            leftSection={<Camera size="0.875rem" />}
            rightSection={
              <Text size="xs" c="dimmed">
                {formatKeymap(keyMap.TAKE_SNAPSHOT.keys)}
              </Text>
            }
            onClick={() => void takeSnapshot()}
          >
            {t("Board.Action.TakeSnapshot")}
          </Menu.Item>
          {canEdit && (
            <Menu.Item
              role="menuitemcheckbox"
              aria-checked={editingMode}
              leftSection={editingMode ? <PencilOff size="0.875rem" /> : <Pencil size="0.875rem" />}
              rightSection={
                <Group gap={6} wrap="nowrap">
                  {editingMode && <Check size="0.875rem" />}
                  <Text size="xs" c="dimmed">
                    {formatKeymap(keyMap.EDIT_POSITION.keys)}
                  </Text>
                </Group>
              }
              onClick={() => toggleEditingMode()}
            >
              {t("Board.Action.EditPosition")}
            </Menu.Item>
          )}
          {showLayouts && onApplyLayout && onSaveLayoutAs && onManageLayouts && (
            <>
              <Menu.Divider />
              <Menu.Label>{t("Board.Layout.Section")}</Menu.Label>
              {layoutList.map((entry) => {
                const id = entry.kind === "preset" ? entry.preset.id : entry.saved.id;
                const label = entry.kind === "preset" ? t(entry.preset.nameKey) : entry.saved.name;
                return (
                  <Menu.Item key={id} onClick={() => onApplyLayout(id)}>
                    {label}
                  </Menu.Item>
                );
              })}
              <Menu.Divider />
              <Menu.Item leftSection={<BookmarkPlus size="0.875rem" />} onClick={onSaveLayoutAs}>
                {t("Board.Layout.SaveAs")}
              </Menu.Item>
              <Menu.Item leftSection={<LayoutGrid size="0.875rem" />} onClick={onManageLayouts}>
                {t("Board.Layout.Manage")}
              </Menu.Item>
              {onShowTabs && (
                <Menu.Item leftSection={<PanelTop size="0.875rem" />} onClick={onShowTabs}>
                  {t("Board.Arrange.ShowTabs")}
                </Menu.Item>
              )}
            </>
          )}
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}

export default memo(BoardControls);
