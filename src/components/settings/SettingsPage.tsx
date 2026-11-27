import { tauri } from "@/platform/tauri";
import {
  Button,
  Card,
  Group,
  ScrollArea,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
  VisuallyHidden,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useHotkeys } from "@mantine/hooks";
import { RotateCcw, Search } from "lucide-react";
import { useLoaderData, useNavigate } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { RESET } from "jotai/utils";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSWRConfig } from "swr";
import { changeLocale } from "@/i18n";
import { runFolderSwitch } from "./folderSwitch";
import { publishDatabaseList } from "@/hooks/useDatabaseList";
import { useScaledMaxWidth } from "@/hooks/useScaledMaxWidth";
import {
  autoPromoteAtom,
  autoSaveAtom,
  chooseVariationAtom,
  defaultPanelTabAtom,
  type DefaultPanelTab,
  enableBoardScrollAtom,
  eraseDrawablesOnClickAtom,
  materialDisplayAtom,
  type MaterialDisplay,
  boardAnimationSpeedAtom,
  type BoardAnimationSpeed,
  moveHighlightAtom,
  lastMoveHighlightOpacityAtom,
  moveInputAtom,
  moveMethodAtom,
  moveNotationTypeAtom,
  nativeBarAtom,
  pieceSizeAtom,
  practiceGradingAtom,
  practiceNewPerSessionAtom,
  PRACTICE_NEW_PER_SESSION,
  previewBoardOnHoverAtom,
  flipBoardAfterMoveAtom,
  fontSizeAtom,
  hidePreviewMovesAtom,
  showArrowsAtom,
  showConsecutiveArrowsAtom,
  showCoordinatesAtom,
  showDestsAtom,
  showVariationArrowsAtom,
  snapArrowsAtom,
  spellCheckAtom,
  fileWorkspaceAtom,
  fileWorkspaceDisplayNameAtom,
  boardWoodTextureAtom,
  puzzleWorkspaceGenerationAtom,
  restoreOpenTabsAtom,
} from "@/state/atoms";
import { coachEnabledAtom } from "@/state/coach";
import {
  clearSettingsScrollKey,
  getSettingsScrollGeneration,
  readSettingsScroll,
  recordSettingsScroll,
  settingsNavigationRequestAtom,
  settingsScrollKeyId,
  type SettingsScrollKey,
} from "@/state/settingsNavigation";
import { Route, settingsRouteSearch } from "@/routes/settings";
import { keybindLabel, keyMapAtom } from "@/state/keybinds";
import { resetBoardLayoutsAtom } from "@/state/layoutStorage";
import { FONT_SCALE_MAX, FONT_SCALE_MIN, FONT_SCALE_STEP } from "@/state/fontScale";
import { PIECE_SCALE_MAX, PIECE_SCALE_MIN, PIECE_SCALE_STEP } from "@/state/pieceScale";
import {
  LAST_MOVE_HIGHLIGHT_OPACITY_MAX,
  LAST_MOVE_HIGHLIGHT_OPACITY_MIN,
  LAST_MOVE_HIGHLIGHT_OPACITY_STEP,
} from "@/state/lastMoveHighlight";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { ensureFileWorkspace, usePlatform, writeDefaultFileWorkspace } from "@/utils/files";
import type { FileWorkspaceHandle, FolderStatus, WorkspaceChoice } from "@/bindings";
import type { RootFailureDomain } from "@/components/files/listingFailure";
import { useSingleFlight } from "@/hooks/useSingleFlight";
import DraftNumberInput from "../common/DraftNumberInput";
import { GroupedSidebarTabs, type GroupedSidebarGroup } from "../common/GroupedSidebarTabs";
import { IconAction } from "../common/IconAction";
import { clearSavedData, openAppLogs, reloadApp } from "./advancedActions";
import BoardSelect from "./BoardSelect";
import BoardSettingsPreview from "./BoardSettingsPreview";
import { CoachConnections } from "./coach/CoachConnections";
import { CoachEngineSelect } from "./coach/CoachEngineSelect";
import { CoachModelSetting } from "./coach/CoachModelSetting";
import KeybindInput from "./KeybindInput";
import LastMoveHighlightColorInput from "./LastMoveHighlightColorInput";
import { DrawingKeybinds } from "./DrawingKeybinds";
import PercentagePreferenceSlider from "./PercentagePreferenceSlider";
import PiecesSelect from "./PiecesSelect";
import RepertoireMinGamesSetting from "./RepertoireMinGamesSetting";
import { WorkspaceDirectorySetting } from "./WorkspaceDirectorySetting";
import shellClasses from "../common/SidebarTabsPage.module.css";
import classes from "./SettingsPage.module.css";
import { groupedKeybindActions, keybindGroupTitle } from "./keybindGroups";
import { SettingRow } from "./SettingsLayout";
import {
  describeSettings,
  isLastMoveHighlightChild,
  SETTING_CATEGORY_EMOJI,
  SETTING_CONTENT_GROUP_EMOJI,
  settingCategoryGroupTitle,
  settingCategoryTitle,
  settingContentGroupTitle,
  settingSearchGroupLabel,
  visibleSettingCategories,
  visibleSettingCategoryGroups,
  type SettingCategory,
  type SettingContentGroup,
  type SettingDescription,
  type SettingId,
} from "./settingsDescription";
import SettingsSelect from "./SettingsSelect";
import SettingsSwitch from "./SettingsSwitch";
import SoundSelect from "./SoundSelect";
import ThemeButton from "./ThemeButton";
import VolumeSlider from "./VolumeSlider";

async function switchWorkspaceFolder(
  choose: () => Promise<WorkspaceChoice<{ displayName: string }>>,
  loadStatus: () => Promise<FolderStatus>,
): Promise<FolderStatus | null> {
  const result = await runFolderSwitch(choose);
  if (!result.switched) return null;
  return result.status ?? (await loadStatus());
}

const FONT_SIZE_MARKS = [FONT_SCALE_MIN, 100, 150, FONT_SCALE_MAX];
const PIECE_SIZE_MARKS = [PIECE_SCALE_MIN, 85, PIECE_SCALE_MAX];
const MOVE_HIGHLIGHT_OPACITY_MARKS = [
  LAST_MOVE_HIGHLIGHT_OPACITY_MIN,
  40,
  70,
  LAST_MOVE_HIGHLIGHT_OPACITY_MAX,
];

const COMPACT_SETTINGS_WIDTH_EM = 50;
const MAX_PENDING_WRITTEN_QUERIES = 32;

function AdvancedActionButton({
  label,
  action,
  successMessage,
}: {
  label: string;
  action: () => void | Promise<unknown>;
  successMessage?: string;
}) {
  const { t } = useTranslation();
  const { pending, run } = useSingleFlight();
  return (
    <Button
      variant="default"
      disabled={pending}
      aria-busy={pending || undefined}
      onClick={() =>
        void run(async () => {
          try {
            await action();
            if (successMessage) notifications.show({ message: successMessage });
          } catch (error) {
            notifyUnlessCancelled(t("Common.Error"), error);
          }
        })
      }
    >
      {label}
    </Button>
  );
}

export async function loadPgnDirectoryStatus(fileWorkspace: FileWorkspaceHandle | null) {
  const workspace = fileWorkspace ?? (await ensureFileWorkspace());
  if (!workspace) throw new Error("no workspace");
  return tauri.getFileFolderStatus(workspace);
}

function scrollViewportTo(viewport: HTMLDivElement | null, top: number) {
  if (!viewport) return;
  if (typeof viewport.scrollTo === "function") {
    viewport.scrollTo({ top, behavior: "auto" });
  }
  viewport.scrollTop = top;
}

export default function Page() {
  const { t, i18n } = useTranslation();
  const { mutate: mutateCache } = useSWRConfig();
  const navigate = useNavigate();
  const { category: urlCategory, q: urlQuery } = Route.useSearch();
  const activeCategory: SettingCategory = urlCategory ?? "board";
  const normalizedUrlQuery = urlQuery ?? "";
  const compactTabs = useScaledMaxWidth(COMPACT_SETTINGS_WIDTH_EM);
  const [searchQuery, setSearchQuery] = useState(normalizedUrlQuery);
  const pendingWrittenQueriesRef = useRef<string[]>([]);
  const prevUrlQueryRef = useRef(normalizedUrlQuery);
  const [highlightedSettingId, setHighlightedSettingId] = useState<SettingId | null>(null);
  const [pendingScroll, setPendingScroll] = useState<{
    settingId: SettingId;
    category: SettingCategory;
  } | null>(null);
  const [navigationRequest, setNavigationRequest] = useAtom(settingsNavigationRequestAtom);
  const pageRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const categoryViewportRef = useRef<HTMLDivElement>(null);
  const searchViewportRef = useRef<HTMLDivElement>(null);
  const scrollGenerationRef = useRef(getSettingsScrollGeneration());
  const restoredScrollKeyRef = useRef<string | null>(null);
  const suppressScrollRecordRef = useRef(false);

  useEffect(() => {
    if (normalizedUrlQuery === prevUrlQueryRef.current) return;
    prevUrlQueryRef.current = normalizedUrlQuery;
    const matchIndex = pendingWrittenQueriesRef.current.indexOf(normalizedUrlQuery);
    if (matchIndex !== -1) {
      pendingWrittenQueriesRef.current.splice(0, matchIndex + 1);
      return;
    }
    pendingWrittenQueriesRef.current = [];
    setSearchQuery(normalizedUrlQuery);
  }, [normalizedUrlQuery]);

  const updateSearchQuery = useCallback(
    (nextQuery: string) => {
      setSearchQuery(nextQuery);
      setPendingScroll(null);
      const latestPendingOrCommitted =
        pendingWrittenQueriesRef.current.at(-1) ?? prevUrlQueryRef.current;
      if (nextQuery !== latestPendingOrCommitted) {
        pendingWrittenQueriesRef.current.push(nextQuery);
        if (pendingWrittenQueriesRef.current.length > MAX_PENDING_WRITTEN_QUERIES) {
          pendingWrittenQueriesRef.current.splice(
            0,
            pendingWrittenQueriesRef.current.length - MAX_PENDING_WRITTEN_QUERIES,
          );
        }
      }
      void navigate({
        to: "/settings",
        search: settingsRouteSearch(activeCategory, nextQuery),
        replace: true,
      });
    },
    [activeCategory, navigate],
  );

  const [keyMap, setKeyMap] = useAtom(keyMapAtom);
  const [isNative, setIsNative] = useAtom(nativeBarAtom);
  const { version } = useLoaderData({ from: "/settings" });
  const [fileWorkspace, setFileWorkspace] = useAtom(fileWorkspaceAtom);
  const [, setFileWorkspaceDisplayName] = useAtom(fileWorkspaceDisplayNameAtom);
  const [, setPuzzleWorkspaceGeneration] = useAtom(puzzleWorkspaceGenerationAtom);
  const showDirectoryError = useCallback(
    (error: unknown, domain: RootFailureDomain) => {
      notifyUnlessCancelled(t("Common.Error"), error, domain);
    },
    [t],
  );
  const [moveMethod, setMoveMethod] = useAtom(moveMethodAtom);
  const [moveNotationType, setMoveNotationType] = useAtom(moveNotationTypeAtom);
  const [showCoordinates, setShowCoordinates] = useAtom(showCoordinatesAtom);
  const [animationSpeed, setAnimationSpeed] = useAtom(boardAnimationSpeedAtom);
  const [materialDisplay, setMaterialDisplay] = useAtom(materialDisplayAtom);
  const [defaultPanelTab, setDefaultPanelTab] = useAtom(defaultPanelTabAtom);
  const resetBoardLayouts = useSetAtom(resetBoardLayoutsAtom);
  const [practiceGrading, setPracticeGrading] = useAtom(practiceGradingAtom);
  const [practiceNewPerSession, setPracticeNewPerSession] = useAtom(practiceNewPerSessionAtom);
  // A build without the Coach shows nothing of it: no category, no rows, no search results.
  const coachEnabled = useAtomValue(coachEnabledAtom);
  const moveHighlight = useAtomValue(moveHighlightAtom);
  const categories = useMemo(() => visibleSettingCategories({ coachEnabled }), [coachEnabled]);
  const categoryGroups = useMemo(
    () => visibleSettingCategoryGroups({ coachEnabled }),
    [coachEnabled],
  );
  const effectiveCategory = categories.includes(activeCategory) ? activeCategory : categories[0];
  const { os } = usePlatform();

  const settings = useMemo(
    () =>
      describeSettings(t, {
        platform: import.meta.env.VITE_PLATFORM,
        coachEnabled,
      }).filter((setting) => setting.shown),
    [t, coachEnabled],
  );

  const settingControls: Record<SettingId, () => React.ReactNode> = useMemo(
    () => ({
      "piece-dest": () => <SettingsSwitch atom={showDestsAtom} />,
      "move-highlight": () => <SettingsSwitch atom={moveHighlightAtom} />,
      "move-highlight-color": () => <LastMoveHighlightColorInput />,
      "move-highlight-opacity": () => (
        <PercentagePreferenceSlider
          atom={lastMoveHighlightOpacityAtom}
          min={LAST_MOVE_HIGHLIGHT_OPACITY_MIN}
          max={LAST_MOVE_HIGHLIGHT_OPACITY_MAX}
          step={LAST_MOVE_HIGHLIGHT_OPACITY_STEP}
          marks={MOVE_HIGHLIGHT_OPACITY_MARKS}
          thumbLabel={t("Settings.MoveHighlightOpacity")}
        />
      ),
      arrows: () => <SettingsSwitch atom={showArrowsAtom} />,
      "variation-arrows": () => <SettingsSwitch atom={showVariationArrowsAtom} />,
      "move-notation": () => (
        <SettingsSelect
          data={[
            { label: t("Settings.MoveNotation.Letters"), value: "letters" },
            { label: t("Settings.MoveNotation.Symbols"), value: "symbols" },
          ]}
          allowDeselect={false}
          value={moveNotationType}
          onChange={(val) => setMoveNotationType(val as "letters" | "symbols")}
        />
      ),
      "move-method": () => (
        <SettingsSelect
          data={[
            { label: t("Settings.MoveMethod.Drag"), value: "drag" },
            { label: t("Settings.MoveMethod.Click"), value: "select" },
            { label: t("Settings.MoveMethod.Both"), value: "both" },
          ]}
          allowDeselect={false}
          value={moveMethod}
          onChange={(val) => setMoveMethod(val as "drag" | "select" | "both")}
        />
      ),
      "snap-arrows": () => <SettingsSwitch atom={snapArrowsAtom} />,
      "consecutive-arrows": () => <SettingsSwitch atom={showConsecutiveArrowsAtom} />,
      "erase-drawables": () => <SettingsSwitch atom={eraseDrawablesOnClickAtom} />,
      "auto-promote": () => <SettingsSwitch atom={autoPromoteAtom} />,
      coordinates: () => (
        <SettingsSelect
          data={[
            { label: t("Settings.Coordinates.None"), value: "no" },
            { label: t("Settings.Coordinates.Edge"), value: "edge" },
            { label: t("Settings.Coordinates.All"), value: "all" },
          ]}
          allowDeselect={false}
          value={showCoordinates}
          onChange={(val) => setShowCoordinates(val as "no" | "edge" | "all")}
        />
      ),
      "animation-speed": () => (
        <SettingsSelect
          data={[
            { label: t("Settings.AnimationSpeed.Off"), value: "off" },
            { label: t("Settings.AnimationSpeed.Fast"), value: "fast" },
            { label: t("Settings.AnimationSpeed.Normal"), value: "normal" },
            { label: t("Settings.AnimationSpeed.Slow"), value: "slow" },
          ]}
          allowDeselect={false}
          value={animationSpeed}
          onChange={(val) => setAnimationSpeed(val as BoardAnimationSpeed)}
        />
      ),
      "auto-save": () => <SettingsSwitch atom={autoSaveAtom} />,
      "preview-board": () => <SettingsSwitch atom={previewBoardOnHoverAtom} />,
      "flip-board-after-move": () => <SettingsSwitch atom={flipBoardAfterMoveAtom} />,
      "scroll-moves": () => <SettingsSwitch atom={enableBoardScrollAtom} />,
      "choose-variation": () => <SettingsSwitch atom={chooseVariationAtom} />,
      "material-display": () => (
        <SettingsSelect
          data={[
            { label: t("Settings.MaterialDisplay.Diff"), value: "diff" },
            { label: t("Settings.MaterialDisplay.All"), value: "all" },
            { label: t("Settings.MaterialDisplay.None"), value: "none" },
          ]}
          allowDeselect={false}
          value={materialDisplay}
          onChange={(val) => setMaterialDisplay(val as MaterialDisplay)}
        />
      ),
      "hide-preview-moves": () => <SettingsSwitch atom={hidePreviewMovesAtom} />,
      "default-panel-tab": () => (
        <SettingsSelect
          data={[
            { label: t("Board.Tabs.Info"), value: "info" },
            { label: t("Board.Tabs.Analysis"), value: "analysis" },
            { label: t("Board.Tabs.Database"), value: "database" },
            { label: t("Board.Tabs.Annotate"), value: "annotate" },
          ]}
          allowDeselect={false}
          value={defaultPanelTab}
          onChange={(val) => setDefaultPanelTab(val as DefaultPanelTab)}
        />
      ),
      "board-layout": () => (
        <Button variant="default" onClick={() => resetBoardLayouts()}>
          {t("Settings.BoardLayout.Reset")}
        </Button>
      ),
      "text-input": () => <SettingsSwitch atom={moveInputAtom} />,
      "spell-check": () => <SettingsSwitch atom={spellCheckAtom} />,
      theme: () => <ThemeButton />,
      language: () => (
        <SettingsSelect
          allowDeselect={false}
          data={[
            { value: "be_BY", label: "Belarusian" },
            { value: "zh_CN", label: "Chinese (Simplified)" },
            { value: "zh_TW", label: "Chinese (Traditional)" },
            { value: "en_GB", label: "English (UK)" },
            { value: "en_US", label: "English (US)" },
            { value: "fr_FR", label: "Français" },
            { value: "pl_PL", label: "Polish" },
            { value: "nb_NO", label: "Norsk bokmål" },
            { value: "pt_PT", label: "Portuguese" },
            { value: "ru_RU", label: "Russian" },
            { value: "es_ES", label: "Spanish" },
            { value: "it_IT", label: "Italian" },
            { value: "uk_UA", label: "Ukrainian" },
            { value: "tr_TR", label: "Türkçe" },
            { value: "ko_KR", label: "한국어" },
            { value: "de_DE", label: "Deutsch" },
          ]}
          value={(i18n.resolvedLanguage || i18n.language || "en-US").replace("-", "_")}
          onChange={(val) => {
            void changeLocale(val?.replace("_", "-") || "en-US");
          }}
        />
      ),
      "title-bar": () => (
        <SettingsSelect
          allowDeselect={false}
          data={[
            {
              value: "Native",
              label: t("Settings.Appearance.TitleBar.Native"),
            },
            {
              value: "Custom",
              label: t("Settings.Appearance.TitleBar.Custom"),
            },
          ]}
          value={isNative ? "Native" : "Custom"}
          onChange={(val) => setIsNative(val === "Native")}
        />
      ),
      "font-size": () => (
        <PercentagePreferenceSlider
          atom={fontSizeAtom}
          min={FONT_SCALE_MIN}
          max={FONT_SCALE_MAX}
          step={FONT_SCALE_STEP}
          marks={FONT_SIZE_MARKS}
          thumbLabel={t("Settings.Appearance.FontSize")}
        />
      ),
      "piece-set": () => <PiecesSelect />,
      "piece-size": () => (
        <PercentagePreferenceSlider
          atom={pieceSizeAtom}
          min={PIECE_SCALE_MIN}
          max={PIECE_SCALE_MAX}
          step={PIECE_SCALE_STEP}
          marks={PIECE_SIZE_MARKS}
          thumbLabel={t("Settings.Appearance.PieceSize")}
        />
      ),
      "board-image": () => <BoardSelect />,
      "board-wood-texture": () => <SettingsSwitch atom={boardWoodTextureAtom} />,
      "repertoire-depth": () => <RepertoireMinGamesSetting />,
      "practice-grading": () => (
        <SettingsSelect
          allowDeselect={false}
          data={[
            { label: t("Settings.Repertoire.Grading.Automatic"), value: "auto" },
            { label: t("Settings.Repertoire.Grading.Manual"), value: "manual" },
          ]}
          aria-label={t("Settings.Repertoire.Grading")}
          value={practiceGrading}
          onChange={(val) => {
            if (val === "auto" || val === "manual") setPracticeGrading(val);
          }}
        />
      ),
      "practice-new-per-session": () => (
        <DraftNumberInput
          aria-label={t("Settings.Repertoire.NewPerSession")}
          min={PRACTICE_NEW_PER_SESSION.min}
          max={PRACTICE_NEW_PER_SESSION.max}
          allowDecimal={false}
          value={practiceNewPerSession}
          onChange={(value) => {
            if (
              typeof value === "number" &&
              Number.isInteger(value) &&
              value >= PRACTICE_NEW_PER_SESSION.min &&
              value <= PRACTICE_NEW_PER_SESSION.max
            )
              setPracticeNewPerSession(value);
          }}
        />
      ),
      volume: () => <VolumeSlider />,
      "sound-collection": () => <SoundSelect />,
      "files-directory": () => (
        <WorkspaceDirectorySetting
          load={() => loadPgnDirectoryStatus(fileWorkspace)}
          reportLoadError
          issue={async () => {
            const workspace = await tauri.issueFileWorkspace(fileWorkspace);
            setFileWorkspace(workspace.handle);
            setFileWorkspaceDisplayName(workspace.displayName);
            return await tauri.getFileFolderStatus(workspace.handle);
          }}
          restoreDefault={async () => {
            const handle = await writeDefaultFileWorkspace();
            return await tauri.getFileFolderStatus(handle);
          }}
          onShowInFolder={
            fileWorkspace
              ? async () => {
                  await tauri.openFileWorkspace(fileWorkspace);
                }
              : undefined
          }
          onError={(error) => showDirectoryError(error, "files")}
        />
      ),
      "databases-directory": () => {
        const switchDatabase = (
          choose: () => Promise<WorkspaceChoice<{ displayName: string }>>,
        ): Promise<FolderStatus | null> =>
          switchWorkspaceFolder(choose, () => tauri.getDatabaseFolderStatus());
        return (
          <WorkspaceDirectorySetting
            load={() => tauri.getDatabaseFolderStatus()}
            issue={() => switchDatabase(() => tauri.issueDatabaseWorkspace())}
            restoreDefault={() => switchDatabase(() => tauri.restoreDatabaseWorkspace())}
            onShowInFolder={async () => {
              await tauri.openDatabaseWorkspace();
            }}
            onSelected={() => {
              void publishDatabaseList(mutateCache).catch(() => undefined);
            }}
            onError={(error) => showDirectoryError(error, "database")}
          />
        );
      },
      "engines-directory": () => {
        const switchEngine = (
          choose: () => Promise<WorkspaceChoice<{ displayName: string }>>,
        ): Promise<FolderStatus | null> =>
          switchWorkspaceFolder(choose, () => tauri.getEngineFolderStatus());
        return (
          <WorkspaceDirectorySetting
            load={() => tauri.getEngineFolderStatus()}
            issue={() => switchEngine(() => tauri.issueEngineWorkspace())}
            restoreDefault={() => switchEngine(() => tauri.restoreEngineWorkspace())}
            onShowInFolder={async () => {
              await tauri.openEngineWorkspace();
            }}
            onSelected={() => {
              void mutateCache(
                (key) =>
                  Array.isArray(key) && (key[0] === "file-exists" || key[0] === "engine-config"),
                undefined,
                { revalidate: true },
              );
              if (os) {
                void mutateCache(os, undefined, { revalidate: true });
              }
            }}
            onError={(error) => showDirectoryError(error, "engine")}
          />
        );
      },
      "puzzles-directory": () => {
        const switchPuzzle = (
          choose: () => Promise<WorkspaceChoice<{ displayName: string }>>,
        ): Promise<FolderStatus | null> =>
          switchWorkspaceFolder(choose, () => tauri.getPuzzleFolderStatus());
        return (
          <WorkspaceDirectorySetting
            load={() => tauri.getPuzzleFolderStatus()}
            issue={() => switchPuzzle(() => tauri.issuePuzzleWorkspace())}
            restoreDefault={() => switchPuzzle(() => tauri.restorePuzzleWorkspace())}
            onShowInFolder={async () => {
              await tauri.openPuzzleWorkspace();
            }}
            onSelected={() => setPuzzleWorkspaceGeneration((generation) => generation + 1)}
            onError={(error) => showDirectoryError(error, "puzzle")}
          />
        );
      },
      "coach-model": () => <CoachModelSetting />,
      "coach-engine": () => <CoachEngineSelect />,
      "restore-open-tabs": () => <SettingsSwitch atom={restoreOpenTabsAtom} />,
      reload: () => <AdvancedActionButton label={t("Menu.View.Reload")} action={reloadApp} />,
      "clear-saved-data": () => (
        <AdvancedActionButton
          label={t("Menu.Help.ClearSavedData")}
          action={() => clearSavedData({ t })}
        />
      ),
      "open-logs": () => (
        <AdvancedActionButton
          label={t("Menu.Help.OpenLogs")}
          action={openAppLogs}
          successMessage={t("Menu.Help.OpenLogs")}
        />
      ),
    }),
    [
      t,
      i18n,
      moveNotationType,
      moveMethod,
      isNative,
      showCoordinates,
      animationSpeed,
      materialDisplay,
      fileWorkspace,
      setMoveNotationType,
      setMoveMethod,
      setIsNative,
      setFileWorkspace,
      setFileWorkspaceDisplayName,
      setPuzzleWorkspaceGeneration,
      setShowCoordinates,
      setAnimationSpeed,
      setMaterialDisplay,
      defaultPanelTab,
      setDefaultPanelTab,
      resetBoardLayouts,
      practiceGrading,
      setPracticeGrading,
      practiceNewPerSession,
      setPracticeNewPerSession,
      showDirectoryError,
      mutateCache,
      os,
    ],
  );

  useHotkeys([["mod+f", () => searchInputRef.current?.focus()]]);

  const categoryInfo: Record<
    SettingCategory,
    { title: string; description: string; emoji: string }
  > = useMemo(
    () => ({
      board: {
        title: settingCategoryTitle(t, "board"),
        description: t("Settings.Board.Desc"),
        emoji: SETTING_CATEGORY_EMOJI.board,
      },
      analysis: {
        title: settingCategoryTitle(t, "analysis"),
        description: t("Settings.Analysis.Desc"),
        emoji: SETTING_CATEGORY_EMOJI.analysis,
      },
      repertoire: {
        title: settingCategoryTitle(t, "repertoire"),
        description: t("Settings.Repertoire.Desc"),
        emoji: SETTING_CATEGORY_EMOJI.repertoire,
      },
      coach: {
        title: settingCategoryTitle(t, "coach"),
        description: t("Settings.Coach.Desc"),
        emoji: SETTING_CATEGORY_EMOJI.coach,
      },
      general: {
        title: settingCategoryTitle(t, "general"),
        description: t("Settings.General.Desc"),
        emoji: SETTING_CATEGORY_EMOJI.general,
      },
      sound: {
        title: settingCategoryTitle(t, "sound"),
        description: t("Settings.Sound.Desc"),
        emoji: SETTING_CATEGORY_EMOJI.sound,
      },
      keybinds: {
        title: settingCategoryTitle(t, "keybinds"),
        description: t("Settings.Keybinds.Desc"),
        emoji: SETTING_CATEGORY_EMOJI.keybinds,
      },
      directories: {
        title: settingCategoryTitle(t, "directories"),
        description: t("Settings.Directories.Desc"),
        emoji: SETTING_CATEGORY_EMOJI.directories,
      },
      advanced: {
        title: settingCategoryTitle(t, "advanced"),
        description: t("Settings.Advanced.Desc"),
        emoji: SETTING_CATEGORY_EMOJI.advanced,
      },
    }),
    [t],
  );

  const sidebarGroups = useMemo((): GroupedSidebarGroup[] => {
    return categoryGroups.map((group) => ({
      id: group.id,
      title: settingCategoryGroupTitle(t, group.id),
      headingProps: { "data-settings-group": group.id },
      tabs: group.categories.map((category) => ({
        value: category,
        label: categoryInfo[category].title,
        emoji: categoryInfo[category].emoji,
        accent: `var(--cf-${group.accent})`,
        tabProps: { "data-settings-category": category },
      })),
    }));
  }, [categoryGroups, categoryInfo, t]);

  const filteredSettings = useMemo(() => {
    if (!searchQuery.trim()) return null;
    const query = searchQuery.toLowerCase();
    return settings.filter((setting) => {
      const groupTitle = setting.group ? settingContentGroupTitle(t, setting.group) : "";
      return (
        setting.title.toLowerCase().includes(query) ||
        setting.description.toLowerCase().includes(query) ||
        categoryInfo[setting.category].title.toLowerCase().includes(query) ||
        groupTitle.toLowerCase().includes(query) ||
        setting.id.toLowerCase().includes(query) ||
        setting.keywords.some((kw) => kw.toLowerCase().includes(query))
      );
    });
  }, [searchQuery, settings, categoryInfo, t]);

  const revealNestedId =
    highlightedSettingId && isLastMoveHighlightChild(highlightedSettingId)
      ? highlightedSettingId
      : pendingScroll && isLastMoveHighlightChild(pendingScroll.settingId)
        ? pendingScroll.settingId
        : null;

  const isSettingRowVisible = (setting: SettingDescription) => {
    if (!isLastMoveHighlightChild(setting.id)) return true;
    if (filteredSettings) return true;
    if (moveHighlight) return true;
    return revealNestedId === setting.id;
  };

  const hasApplicableNavigationRequest = useMemo(() => {
    if (!navigationRequest) return false;
    if (navigationRequest.target.kind === "category") {
      return categories.includes(navigationRequest.target.category);
    }
    const targetId = navigationRequest.target.settingId;
    const targetSetting = settings.find((setting) => setting.id === targetId);
    return Boolean(targetSetting && categories.includes(targetSetting.category));
  }, [navigationRequest, categories, settings]);

  const isSearchView = filteredSettings !== null;
  const currentScrollKey: SettingsScrollKey = useMemo(
    () =>
      isSearchView
        ? { mode: "search", q: searchQuery }
        : { mode: "category", category: effectiveCategory },
    [isSearchView, searchQuery, effectiveCategory],
  );
  const currentScrollKeyId = settingsScrollKeyId(currentScrollKey);
  const currentScrollKeyRef = useRef(currentScrollKey);
  currentScrollKeyRef.current = currentScrollKey;
  const currentScrollKeyIdRef = useRef(currentScrollKeyId);
  currentScrollKeyIdRef.current = currentScrollKeyId;

  useLayoutEffect(() => {
    if (restoredScrollKeyRef.current === currentScrollKeyId) return;
    restoredScrollKeyRef.current = currentScrollKeyId;
    if (hasApplicableNavigationRequest || pendingScroll) return;
    const viewport = isSearchView ? searchViewportRef.current : categoryViewportRef.current;
    const savedY = readSettingsScroll(currentScrollKey) ?? 0;
    suppressScrollRecordRef.current = true;
    scrollViewportTo(viewport, savedY);
    suppressScrollRecordRef.current = false;
  }, [
    currentScrollKey,
    currentScrollKeyId,
    hasApplicableNavigationRequest,
    isSearchView,
    pendingScroll,
  ]);

  useEffect(() => {
    const viewport = isSearchView ? searchViewportRef.current : categoryViewportRef.current;
    if (!viewport) return;
    const onScroll = () => {
      if (suppressScrollRecordRef.current) return;
      if (restoredScrollKeyRef.current !== currentScrollKeyIdRef.current) return;
      recordSettingsScroll(
        currentScrollKeyRef.current,
        viewport.scrollTop,
        scrollGenerationRef.current,
      );
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      viewport.removeEventListener("scroll", onScroll);
    };
  }, [isSearchView]);

  useEffect(() => {
    if (!navigationRequest) return;
    setNavigationRequest((current) => (current?.id === navigationRequest.id ? null : current));

    if (navigationRequest.target.kind === "category") {
      const targetCategory = navigationRequest.target.category;
      if (!categories.includes(targetCategory)) return;
      clearSettingsScrollKey({ mode: "category", category: targetCategory });
      pendingWrittenQueriesRef.current = [];
      setSearchQuery("");
      setHighlightedSettingId(null);
      setPendingScroll(null);
      if (!isSearchView && effectiveCategory === targetCategory) {
        suppressScrollRecordRef.current = true;
        scrollViewportTo(categoryViewportRef.current, 0);
        suppressScrollRecordRef.current = false;
      }
      void navigate({
        to: "/settings",
        search: settingsRouteSearch(targetCategory, ""),
        replace: true,
      });
      return;
    }

    const targetId = navigationRequest.target.settingId;
    const targetSetting = settings.find((setting) => setting.id === targetId);
    if (!targetSetting || !categories.includes(targetSetting.category)) return;
    clearSettingsScrollKey({ mode: "category", category: targetSetting.category });
    pendingWrittenQueriesRef.current = [];
    setSearchQuery("");
    setHighlightedSettingId(targetSetting.id);
    setPendingScroll({ settingId: targetSetting.id, category: targetSetting.category });
    void navigate({
      to: "/settings",
      search: settingsRouteSearch(targetSetting.category, ""),
      replace: true,
    });
  }, [
    navigationRequest,
    categories,
    settings,
    setNavigationRequest,
    navigate,
    effectiveCategory,
    isSearchView,
  ]);

  useEffect(() => {
    if (!pendingScroll || filteredSettings) return;
    if (effectiveCategory !== pendingScroll.category) return;
    const row = pageRef.current?.querySelector<HTMLElement>(
      `[data-setting-id="${pendingScroll.settingId}"]`,
    );
    if (!row) {
      setPendingScroll(null);
      suppressScrollRecordRef.current = true;
      scrollViewportTo(categoryViewportRef.current, 0);
      suppressScrollRecordRef.current = false;
      return;
    }
    row.scrollIntoView?.({ block: "center", behavior: "auto" });
    setPendingScroll(null);
  }, [pendingScroll, filteredSettings, effectiveCategory]);

  const renderSettingRow = (setting: SettingDescription, highlight = false) => (
    <SettingRow
      key={setting.id}
      id={setting.id}
      title={setting.title}
      description={setting.description}
      highlight={highlight}
      nested={isLastMoveHighlightChild(setting.id)}
    >
      {settingControls[setting.id]()}
    </SettingRow>
  );

  const renderGroupHeading = (emoji: string, title: string) => (
    <Group gap="xs" mb="xs" wrap="nowrap">
      <span aria-hidden="true" className={shellClasses.sectionEmoji}>
        {emoji}
      </span>
      <Text size="lg" fw={500} className={classes.title}>
        {title}
      </Text>
    </Group>
  );

  const renderSearchResults = () => {
    if (!filteredSettings) return null;

    if (filteredSettings.length === 0) {
      return (
        <Card withBorder className={`${shellClasses.card} ${classes.card} wrap-anywhere`} w="100%">
          <Text c="dimmed" ta="center">
            {t("Settings.Search.NoResults", { query: searchQuery })}
          </Text>
        </Card>
      );
    }

    const groupedSettings: { label: string; emoji: string; settings: SettingDescription[] }[] = [];
    for (const setting of filteredSettings) {
      const label = settingSearchGroupLabel(t, setting);
      const last = groupedSettings.at(-1);
      if (last && last.label === label) {
        last.settings.push(setting);
      } else {
        groupedSettings.push({
          label,
          emoji: SETTING_CATEGORY_EMOJI[setting.category],
          settings: [setting],
        });
      }
    }

    return (
      <Card withBorder className={`${shellClasses.card} ${classes.card} wrap-anywhere`} w="100%">
        {groupedSettings.map(({ label, emoji, settings: groupSettings }, index) => (
          <div key={label} data-search-group={label}>
            <Group gap="xs" mt={index === 0 ? 0 : "md"} mb="xs">
              <span aria-hidden="true" className={shellClasses.sectionEmoji}>
                {emoji}
              </span>
              <Text fw={500} size="sm" c="dimmed">
                {label}
              </Text>
            </Group>
            {groupSettings.map((setting) => renderSettingRow(setting))}
          </div>
        ))}
      </Card>
    );
  };

  const renderCategorySettings = (category: SettingCategory) => {
    const categorySettings = settings
      .filter((setting) => setting.category === category)
      .filter(isSettingRowVisible);
    const groups: SettingContentGroup[] = [];
    for (const setting of categorySettings) {
      if (setting.group && !groups.includes(setting.group)) groups.push(setting.group);
    }

    if (groups.length === 0) {
      return (
        <Card withBorder className={`${shellClasses.card} ${classes.card} wrap-anywhere`} w="100%">
          {category === "coach" && <CoachConnections />}
          {categorySettings.map((setting) =>
            renderSettingRow(setting, highlightedSettingId === setting.id),
          )}
        </Card>
      );
    }

    return (
      <Stack>
        {groups.map((group) => (
          <Card
            key={group}
            withBorder
            className={`${shellClasses.card} ${classes.card} wrap-anywhere`}
            w="100%"
            data-settings-section={group}
          >
            {renderGroupHeading(
              SETTING_CONTENT_GROUP_EMOJI[group],
              settingContentGroupTitle(t, group),
            )}
            {group === "look" && <BoardSettingsPreview />}
            {categorySettings
              .filter((setting) => setting.group === group)
              .map((setting) => renderSettingRow(setting, highlightedSettingId === setting.id))}
          </Card>
        ))}
      </Stack>
    );
  };

  const renderKeybindTable = (actions: readonly string[]) => {
    if (compactTabs) {
      return (
        <div>
          {actions.map((action) => {
            const keybind = keyMap[action];
            return (
              <Group key={action} justify="space-between" gap="xl" className={classes.item}>
                <div className={classes.settingCopy}>
                  <Text className={classes.settingTitle}>{keybindLabel(t, action, keybind)}</Text>
                </div>
                <div className={classes.settingControl}>
                  <KeybindInput action={action} keybind={keybind} />
                </div>
              </Group>
            );
          })}
        </div>
      );
    }
    return (
      <Table classNames={{ table: classes.keybindTable }}>
        <Table.Thead className={VisuallyHidden.classes.root}>
          <Table.Tr>
            <Table.Th>{t("Common.Description")}</Table.Th>
            <Table.Th>{t("Settings.Key")}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {actions.map((action) => {
            const keybind = keyMap[action];
            return (
              <Table.Tr key={action}>
                <Table.Td>{keybindLabel(t, action, keybind)}</Table.Td>
                <Table.Td>
                  <KeybindInput action={action} keybind={keybind} />
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    );
  };

  const renderKeybinds = () => {
    const { groups, extraActions } = groupedKeybindActions(keyMap, coachEnabled);
    return (
      <Stack>
        {groups.map((group) => (
          <Card
            key={group.id}
            withBorder
            className={`${shellClasses.card} ${classes.card} wrap-anywhere`}
            w="100%"
            data-settings-section={group.id}
          >
            {renderGroupHeading(group.emoji, keybindGroupTitle(t, group.id))}
            {renderKeybindTable(group.actions)}
          </Card>
        ))}
        {extraActions.length > 0 && (
          <Card
            withBorder
            className={`${shellClasses.card} ${classes.card} wrap-anywhere`}
            w="100%"
          >
            {renderKeybindTable(extraActions)}
          </Card>
        )}
        <Card
          withBorder
          className={`${shellClasses.card} ${classes.card} wrap-anywhere`}
          w="100%"
          data-settings-section="drawing"
        >
          <DrawingKeybinds titleClassName={classes.title} />
        </Card>
      </Stack>
    );
  };

  return (
    <Stack ref={pageRef} h="100%" gap={0} data-compact={compactTabs || undefined}>
      <Group px="md" pt="md" pb="sm" className={shellClasses.headerRow}>
        <Title order={1} size="h3" className="wrap-anywhere" miw={0}>
          {t("SideBar.Settings")}
        </Title>
        <TextInput
          ref={searchInputRef}
          placeholder={t("Common.Search")}
          aria-label={t("Common.Search")}
          leftSection={<Search size="1rem" />}
          value={searchQuery}
          onChange={(e) => {
            updateSearchQuery(e.currentTarget.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "f" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
            }
            if (e.key === "Escape") {
              updateSearchQuery("");
              searchInputRef.current?.blur();
            }
          }}
          style={{ flex: 1, maxWidth: 400 }}
        />
      </Group>
      {filteredSettings ? (
        <ScrollArea flex={1} px="md" viewportRef={searchViewportRef}>
          <div className={classes.panel}>{renderSearchResults()}</div>
          <Text size="xs" c="dimmed" ta="right" py="md">
            {t("Settings.Version", { version })}
          </Text>
        </ScrollArea>
      ) : (
        <Tabs
          value={effectiveCategory}
          onChange={(value) => {
            if (value && categories.includes(value as SettingCategory)) {
              const nextCategory = value as SettingCategory;
              pendingWrittenQueriesRef.current = [];
              setSearchQuery("");
              setHighlightedSettingId(null);
              setPendingScroll(null);
              void navigate({
                to: "/settings",
                search: settingsRouteSearch(nextCategory, ""),
              });
            }
          }}
          orientation={compactTabs ? "horizontal" : "vertical"}
          flex={1}
          className={shellClasses.tabs}
          classNames={{
            list: shellClasses.list,
            tab: shellClasses.tab,
          }}
          styles={{
            tabLabel: {
              textAlign: "left",
            },
          }}
        >
          <GroupedSidebarTabs groups={sidebarGroups} compact={compactTabs} />
          <Stack flex={1} className={shellClasses.content}>
            <ScrollArea className={shellClasses.scroll} viewportRef={categoryViewportRef}>
              {categories.map((category) => {
                const title = (
                  <Text size="lg" fw={500} className={`${classes.title} wrap-anywhere`}>
                    {categoryInfo[category].title}
                  </Text>
                );
                const isKeybinds = category === "keybinds";
                return (
                  <Tabs.Panel key={category} value={category} className={classes.panel}>
                    {isKeybinds ? (
                      <Group>
                        {title}
                        <IconAction label={t("Common.Reset")} onClick={() => setKeyMap(RESET)}>
                          <RotateCcw size="1rem" />
                        </IconAction>
                      </Group>
                    ) : (
                      title
                    )}
                    <Text size="xs" c="dimmed" mt={3} mb="lg">
                      {categoryInfo[category].description}
                    </Text>
                    {isKeybinds ? renderKeybinds() : renderCategorySettings(category)}
                  </Tabs.Panel>
                );
              })}
            </ScrollArea>
            <Text size="xs" c="dimmed" ta="right">
              {t("Settings.Version", { version })}
            </Text>
          </Stack>
        </Tabs>
      )}
    </Stack>
  );
}
