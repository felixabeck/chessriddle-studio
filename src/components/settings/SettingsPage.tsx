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
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useHotkeys } from "@mantine/hooks";
import {
  BookOpen,
  MessagesSquare,
  Palette,
  ChessKnight,
  Wrench,
  Folder,
  Keyboard,
  Mouse,
  RotateCcw,
  Search,
  Volume2,
} from "lucide-react";
import { useLoaderData } from "@tanstack/react-router";
import { useAtom, useAtomValue } from "jotai";
import { RESET } from "jotai/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { changeLocale } from "@/i18n";
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
} from "@/state/atoms";
import { coachEnabledAtom } from "@/state/coach";
import { settingsNavigationRequestAtom } from "@/state/settingsNavigation";
import { keybindLabel, keyMapAtom } from "@/state/keybinds";
import { panelsBesideNotationAtom } from "@/state/layoutStorage";
import { FONT_SCALE_MAX, FONT_SCALE_MIN, FONT_SCALE_STEP } from "@/state/fontScale";
import { PIECE_SCALE_MAX, PIECE_SCALE_MIN, PIECE_SCALE_STEP } from "@/state/pieceScale";
import {
  LAST_MOVE_HIGHLIGHT_OPACITY_MAX,
  LAST_MOVE_HIGHLIGHT_OPACITY_MIN,
  LAST_MOVE_HIGHLIGHT_OPACITY_STEP,
} from "@/state/lastMoveHighlight";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { useSingleFlight } from "@/hooks/useSingleFlight";
import DraftNumberInput from "../common/DraftNumberInput";
import { IconAction } from "../common/IconAction";
import { clearSavedData, openAppLogs, reloadApp } from "./advancedActions";
import BoardSelect from "./BoardSelect";
import { CoachConnections } from "./coach/CoachConnections";
import { CoachEngineSelect } from "./coach/CoachEngineSelect";
import KeybindInput from "./KeybindInput";
import LastMoveHighlightColorInput from "./LastMoveHighlightColorInput";
import { DrawingKeybinds } from "./DrawingKeybinds";
import PercentagePreferenceSlider from "./PercentagePreferenceSlider";
import PiecesSelect from "./PiecesSelect";
import RepertoireMinGamesSetting from "./RepertoireMinGamesSetting";
import { DirectorySetting } from "./DirectorySetting";
import { WorkspaceDirectorySetting } from "./WorkspaceDirectorySetting";
import classes from "./SettingsPage.module.css";
import { SettingRow } from "./SettingsLayout";
import {
  describeSettings,
  visibleSettingCategories,
  type SettingCategory,
  type SettingDescription,
  type SettingId,
} from "./settingsDescription";
import SettingsSelect from "./SettingsSelect";
import SettingsSwitch from "./SettingsSwitch";
import SoundSelect from "./SoundSelect";
import ThemeButton from "./ThemeButton";
import VolumeSlider from "./VolumeSlider";

const FONT_SIZE_MARKS = [FONT_SCALE_MIN, 100, 150, FONT_SCALE_MAX];
const PIECE_SIZE_MARKS = [PIECE_SCALE_MIN, 85, PIECE_SCALE_MAX];
const MOVE_HIGHLIGHT_OPACITY_MARKS = [
  LAST_MOVE_HIGHLIGHT_OPACITY_MIN,
  40,
  70,
  LAST_MOVE_HIGHLIGHT_OPACITY_MAX,
];

const COMPACT_SETTINGS_WIDTH_EM = 50;

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

export default function Page() {
  const { t, i18n } = useTranslation();
  const compactTabs = useScaledMaxWidth(COMPACT_SETTINGS_WIDTH_EM);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<SettingCategory>("board");
  const [highlightedSettingId, setHighlightedSettingId] = useState<SettingId | null>(null);
  const [pendingScroll, setPendingScroll] = useState<{ settingId: SettingId } | null>(null);
  const [navigationRequest, setNavigationRequest] = useAtom(settingsNavigationRequestAtom);
  const pageRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [keyMap, setKeyMap] = useAtom(keyMapAtom);
  const [isNative, setIsNative] = useAtom(nativeBarAtom);
  const { version } = useLoaderData({ from: "/settings" });
  const [, setFileWorkspace] = useAtom(fileWorkspaceAtom);
  const [fileWorkspaceDisplayName, setFileWorkspaceDisplayName] = useAtom(
    fileWorkspaceDisplayNameAtom,
  );
  const [, setPuzzleWorkspaceGeneration] = useAtom(puzzleWorkspaceGenerationAtom);
  const showDirectoryError = useCallback(
    (error: unknown) => {
      notifyUnlessCancelled(t("Common.Error"), error);
    },
    [t],
  );
  const [moveMethod, setMoveMethod] = useAtom(moveMethodAtom);
  const [moveNotationType, setMoveNotationType] = useAtom(moveNotationTypeAtom);
  const [showCoordinates, setShowCoordinates] = useAtom(showCoordinatesAtom);
  const [animationSpeed, setAnimationSpeed] = useAtom(boardAnimationSpeedAtom);
  const [materialDisplay, setMaterialDisplay] = useAtom(materialDisplayAtom);
  const [defaultPanelTab, setDefaultPanelTab] = useAtom(defaultPanelTabAtom);
  const [practiceGrading, setPracticeGrading] = useAtom(practiceGradingAtom);
  const [practiceNewPerSession, setPracticeNewPerSession] = useAtom(practiceNewPerSessionAtom);
  // A build without the Coach shows nothing of it: no category, no rows, no search results.
  const coachEnabled = useAtomValue(coachEnabledAtom);
  const categories = useMemo(() => visibleSettingCategories({ coachEnabled }), [coachEnabled]);
  const effectiveCategory = categories.includes(activeCategory) ? activeCategory : categories[0];

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
      "panels-beside-notation": () => <SettingsSwitch atom={panelsBesideNotationAtom} />,
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
        <DirectorySetting
          value={fileWorkspaceDisplayName || null}
          issueWorkspace={async () => {
            const workspace = await tauri.issueFileWorkspace();
            setFileWorkspace(workspace.handle);
            return workspace.displayName;
          }}
          onSelect={setFileWorkspaceDisplayName}
          onError={showDirectoryError}
        />
      ),
      "databases-directory": () => (
        <WorkspaceDirectorySetting
          load={() => tauri.getDatabaseWorkspace()}
          issue={() => tauri.issueDatabaseWorkspace()}
          onError={showDirectoryError}
        />
      ),
      "engines-directory": () => (
        <WorkspaceDirectorySetting
          load={() => tauri.getEngineWorkspace()}
          issue={() => tauri.issueEngineWorkspace()}
          onError={showDirectoryError}
        />
      ),
      "puzzles-directory": () => (
        <WorkspaceDirectorySetting
          load={() => tauri.getPuzzleWorkspace()}
          issue={() => tauri.issuePuzzleWorkspace()}
          onSelected={() => setPuzzleWorkspaceGeneration((generation) => generation + 1)}
          onError={showDirectoryError}
        />
      ),
      "coach-engine": () => <CoachEngineSelect />,
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
      fileWorkspaceDisplayName,
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
      practiceGrading,
      setPracticeGrading,
      practiceNewPerSession,
      setPracticeNewPerSession,
      showDirectoryError,
    ],
  );

  useHotkeys([["mod+f", () => searchInputRef.current?.focus()]]);

  const categoryInfo: Record<
    SettingCategory,
    { title: string; description: string; icon: React.ReactNode }
  > = useMemo(
    () => ({
      board: {
        title: t("Settings.Board"),
        description: t("Settings.Board.Desc"),
        icon: <ChessKnight size="1rem" />,
      },
      inputs: {
        title: t("Settings.Inputs"),
        description: t("Settings.Inputs.Desc"),
        icon: <Mouse size="1rem" />,
      },
      appearance: {
        title: t("Settings.Appearance"),
        description: t("Settings.Appearance.Desc"),
        icon: <Palette size="1rem" />,
      },
      sound: {
        title: t("Settings.Sound"),
        description: t("Settings.Sound.Desc"),
        icon: <Volume2 size="1rem" />,
      },
      keybinds: {
        title: t("Settings.Keybinds"),
        description: t("Settings.Keybinds.Desc"),
        icon: <Keyboard size="1rem" />,
      },
      directories: {
        title: t("Settings.Directories"),
        description: t("Settings.Directories.Desc"),
        icon: <Folder size="1rem" />,
      },
      repertoire: {
        title: t("Settings.Repertoire"),
        description: t("Settings.Repertoire.Desc"),
        icon: <BookOpen size="1rem" />,
      },
      coach: {
        title: t("Settings.Coach"),
        description: t("Settings.Coach.Desc"),
        icon: <MessagesSquare size="1rem" />,
      },
      advanced: {
        title: t("Settings.Advanced"),
        description: t("Settings.Advanced.Desc"),
        icon: <Wrench size="1rem" />,
      },
    }),
    [t],
  );

  const filteredSettings = useMemo(() => {
    if (!searchQuery.trim()) return null;
    const query = searchQuery.toLowerCase();
    return settings.filter(
      (setting) =>
        setting.title.toLowerCase().includes(query) ||
        setting.description.toLowerCase().includes(query) ||
        categoryInfo[setting.category].title.toLowerCase().includes(query) ||
        setting.id.toLowerCase().includes(query) ||
        setting.keywords.some((kw) => kw.toLowerCase().includes(query)),
    );
  }, [searchQuery, settings, categoryInfo]);

  useEffect(() => {
    if (!navigationRequest) return;
    setNavigationRequest((current) => (current?.id === navigationRequest.id ? null : current));

    if (navigationRequest.target.kind === "category") {
      if (!categories.includes(navigationRequest.target.category)) return;
      setSearchQuery("");
      setActiveCategory(navigationRequest.target.category);
      setHighlightedSettingId(null);
      setPendingScroll(null);
      return;
    }

    const targetId = navigationRequest.target.settingId;
    const targetSetting = settings.find((setting) => setting.id === targetId);
    if (!targetSetting || !categories.includes(targetSetting.category)) return;
    setSearchQuery("");
    setActiveCategory(targetSetting.category);
    setHighlightedSettingId(targetSetting.id);
    setPendingScroll({ settingId: targetSetting.id });
  }, [navigationRequest, categories, settings, setNavigationRequest]);

  useEffect(() => {
    if (!pendingScroll || filteredSettings) return;
    const row = pageRef.current?.querySelector<HTMLElement>(
      `[data-setting-id="${pendingScroll.settingId}"]`,
    );
    if (!row) return;
    row.scrollIntoView?.({ block: "center", behavior: "auto" });
    setPendingScroll(null);
  }, [pendingScroll, filteredSettings, effectiveCategory]);

  const renderSearchResults = () => {
    if (!filteredSettings) return null;

    if (filteredSettings.length === 0) {
      return (
        <Card withBorder className={`${classes.card} wrap-anywhere`} w="100%">
          <Text c="dimmed" ta="center">
            {t("Settings.Search.NoResults", { query: searchQuery })}
          </Text>
        </Card>
      );
    }

    // Group filtered settings by category
    const groupedSettings = filteredSettings.reduce(
      (acc, setting) => {
        if (!acc[setting.category]) {
          acc[setting.category] = [];
        }
        acc[setting.category].push(setting);
        return acc;
      },
      {} as Record<SettingCategory, SettingDescription[]>,
    );

    return (
      <Card withBorder className={`${classes.card} wrap-anywhere`} w="100%">
        {Object.entries(groupedSettings).map(([category, categorySettings]) => (
          <div key={category}>
            <Group gap="xs" mt="md" mb="xs">
              {categoryInfo[category as SettingCategory].icon}
              <Text fw={500} size="sm" c="dimmed">
                {categoryInfo[category as SettingCategory].title}
              </Text>
            </Group>
            {categorySettings.map((setting) => (
              <SettingRow
                key={setting.id}
                id={setting.id}
                title={setting.title}
                description={setting.description}
              >
                {settingControls[setting.id]()}
              </SettingRow>
            ))}
          </div>
        ))}
      </Card>
    );
  };

  const renderCategorySettings = (category: SettingCategory) => {
    const categorySettings = settings.filter((s) => s.category === category);
    return categorySettings.map((setting) => (
      <SettingRow
        key={setting.id}
        id={setting.id}
        title={setting.title}
        description={setting.description}
        highlight={highlightedSettingId === setting.id}
      >
        {settingControls[setting.id]()}
      </SettingRow>
    ));
  };

  const renderKeybinds = () => (
    <>
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t("Common.Description")}</Table.Th>
            <Table.Th>{t("Settings.Key")}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {Object.entries(keyMap)
            .filter(([action]) => coachEnabled || action !== "COACH_TAB")
            .map(([action, keybind]) => (
              <Table.Tr key={action}>
                <Table.Td>{keybindLabel(t, action, keybind)}</Table.Td>
                <Table.Td>
                  <KeybindInput action={action} keybind={keybind} />
                </Table.Td>
              </Table.Tr>
            ))}
        </Table.Tbody>
      </Table>
      <DrawingKeybinds titleClassName={classes.title} />
    </>
  );

  return (
    <Stack ref={pageRef} h="100%" gap={0} data-compact={compactTabs || undefined}>
      <Group px="md" pt="md" pb="sm" className={classes.searchRow}>
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
            setSearchQuery(e.currentTarget.value);
            setPendingScroll(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "f" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
            }
            if (e.key === "Escape") {
              setSearchQuery("");
              searchInputRef.current?.blur();
            }
          }}
          style={{ flex: 1, maxWidth: 400 }}
        />
      </Group>
      {filteredSettings ? (
        <ScrollArea flex={1} px="md">
          {renderSearchResults()}
          <Text size="xs" c="dimmed" ta="right" py="md">
            {t("Settings.Version", { version })}
          </Text>
        </ScrollArea>
      ) : (
        <Tabs
          value={effectiveCategory}
          onChange={(value) => {
            if (value && categories.includes(value as SettingCategory)) {
              setActiveCategory(value as SettingCategory);
              setHighlightedSettingId(null);
              setPendingScroll(null);
            }
          }}
          orientation={compactTabs ? "horizontal" : "vertical"}
          flex={1}
          className={classes.settingsTabs}
          classNames={{ list: classes.categoryList, tab: classes.categoryTab }}
          styles={{
            tabLabel: {
              textAlign: "left",
            },
          }}
        >
          <Tabs.List h={compactTabs ? undefined : "100%"}>
            {categories.map((category) => (
              <Tabs.Tab key={category} value={category} leftSection={categoryInfo[category].icon}>
                {categoryInfo[category].title}
              </Tabs.Tab>
            ))}
          </Tabs.List>
          <Stack flex={1} className={classes.settingsContent}>
            <ScrollArea className={classes.settingsScroll}>
              <Card withBorder className={`${classes.card} wrap-anywhere`} w="100%">
                {categories.map((category) => {
                  const title = (
                    <Text size="lg" fw={500} className={classes.title}>
                      {categoryInfo[category].title}
                    </Text>
                  );
                  const isKeybinds = category === "keybinds";
                  return (
                    <Tabs.Panel key={category} value={category}>
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
                      {category === "coach" && <CoachConnections />}
                      {isKeybinds ? renderKeybinds() : renderCategorySettings(category)}
                    </Tabs.Panel>
                  );
                })}
              </Card>
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
