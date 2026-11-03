import { tauri } from "@/platform/tauri";
import {
  Card,
  Group,
  ScrollArea,
  Select,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useHotkeys } from "@mantine/hooks";
import {
  BookOpen,
  Palette,
  ChessKnight,
  Folder,
  Keyboard,
  Mouse,
  RotateCcw,
  Search,
  Shield,
  Volume2,
} from "lucide-react";
import { useLoaderData } from "@tanstack/react-router";
import { useAtom } from "jotai";
import { RESET } from "jotai/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { changeLocale } from "@/i18n";
import { useScaledMaxWidth } from "@/hooks/useScaledMaxWidth";
import {
  autoPromoteAtom,
  autoSaveAtom,
  chooseVariationAtom,
  enableBoardScrollAtom,
  eraseDrawablesOnClickAtom,
  materialDisplayAtom,
  boardAnimationSpeedAtom,
  type BoardAnimationSpeed,
  moveHighlightAtom,
  moveInputAtom,
  moveMethodAtom,
  moveNotationTypeAtom,
  nativeBarAtom,
  pieceSizeAtom,
  practiceAutoDifficultyAtom,
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
  telemetryEnabledAtom,
  boardWoodTextureAtom,
  puzzleWorkspaceGenerationAtom,
} from "@/state/atoms";
import { keyMapAtom } from "@/state/keybinds";
import { FONT_SCALE_MAX, FONT_SCALE_MIN, FONT_SCALE_STEP } from "@/state/fontScale";
import { PIECE_SCALE_MAX, PIECE_SCALE_MIN, PIECE_SCALE_STEP } from "@/state/pieceScale";
import { analytics } from "@/platform/analytics";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { IconAction } from "../common/IconAction";
import BoardSelect from "./BoardSelect";
import KeybindInput from "./KeybindInput";
import PercentagePreferenceSlider from "./PercentagePreferenceSlider";
import PiecesSelect from "./PiecesSelect";
import RepertoireMinGamesSetting from "./RepertoireMinGamesSetting";
import { DirectorySetting } from "./DirectorySetting";
import classes from "./SettingsPage.module.css";
import { SettingRow } from "./SettingsLayout";
import SettingsSwitch from "./SettingsSwitch";
import SoundSelect from "./SoundSelect";
import ThemeButton from "./ThemeButton";
import VolumeSlider from "./VolumeSlider";

const FONT_SIZE_MARKS = [FONT_SCALE_MIN, 100, 150, FONT_SCALE_MAX];
const PIECE_SIZE_MARKS = [PIECE_SCALE_MIN, 85, PIECE_SCALE_MAX];

const COMPACT_SETTINGS_WIDTH_EM = 50;

type SettingCategory =
  | "board"
  | "inputs"
  | "appearance"
  | "sound"
  | "keybinds"
  | "directories"
  | "repertoire"
  | "privacy";

interface SettingItem {
  id: string;
  category: SettingCategory;
  title: string;
  description: string;
  keywords?: string[];
  render: () => React.ReactNode;
}

function TelemetrySwitch() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useAtom(telemetryEnabledAtom);
  return (
    <Switch
      aria-label={t("Settings.Privacy.Telemetry")}
      onLabel={t("Common.On")}
      offLabel={t("Common.Off")}
      size="lg"
      checked={enabled}
      onChange={(event) => {
        const newValue = event.currentTarget.checked;
        setEnabled(newValue);
        if (newValue) analytics.enable();
        else analytics.disable();
      }}
      styles={{
        track: { cursor: "pointer" },
        thumb: { pointerEvents: "none" },
      }}
    />
  );
}

export default function Page() {
  const { t, i18n } = useTranslation();
  const compactTabs = useScaledMaxWidth(COMPACT_SETTINGS_WIDTH_EM);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [keyMap, setKeyMap] = useAtom(keyMapAtom);
  const [isNative, setIsNative] = useAtom(nativeBarAtom);
  const { version } = useLoaderData({ from: "/settings" });
  const [, setFileWorkspace] = useAtom(fileWorkspaceAtom);
  const [fileWorkspaceDisplayName, setFileWorkspaceDisplayName] = useAtom(
    fileWorkspaceDisplayNameAtom,
  );
  const [databasesDirectory, setDatabasesDirectory] = useState("Databases");
  const [enginesDirectory, setEnginesDirectory] = useState("Engines");
  const [puzzleWorkspaceName, setPuzzleWorkspaceName] = useState("Puzzles");
  const [, setPuzzleWorkspaceGeneration] = useAtom(puzzleWorkspaceGenerationAtom);
  const showDirectoryError = useCallback(
    (error: unknown) => {
      notifyUnlessCancelled(t("Common.Error"), error);
    },
    [t],
  );
  useEffect(() => {
    void tauri
      .getPuzzleWorkspace()
      .then((workspace) => setPuzzleWorkspaceName(workspace.displayName))
      .catch(() => {});
  }, []);

  const [moveMethod, setMoveMethod] = useAtom(moveMethodAtom);
  const [moveNotationType, setMoveNotationType] = useAtom(moveNotationTypeAtom);
  const [showCoordinates, setShowCoordinates] = useAtom(showCoordinatesAtom);
  const [animationSpeed, setAnimationSpeed] = useAtom(boardAnimationSpeedAtom);
  const [materialDisplay, setMaterialDisplay] = useAtom(materialDisplayAtom);
  const [practiceAutoDifficulty, setPracticeAutoDifficulty] = useAtom(practiceAutoDifficultyAtom);

  const settings: SettingItem[] = useMemo(
    () => [
      // Board settings
      {
        id: "piece-dest",
        category: "board",
        title: t("Settings.PieceDest"),
        description: t("Settings.PieceDest.Desc"),
        keywords: ["destination", "moves", "highlight"],
        render: () => <SettingsSwitch atom={showDestsAtom} />,
      },
      {
        id: "move-highlight",
        category: "board",
        title: t("Settings.MoveHighlight"),
        description: t("Settings.MoveHighlight.Desc"),
        keywords: ["highlight", "last move"],
        render: () => <SettingsSwitch atom={moveHighlightAtom} />,
      },
      {
        id: "arrows",
        category: "board",
        title: t("Settings.Arrows"),
        description: t("Settings.Arrows.Desc"),
        keywords: ["arrows", "analysis"],
        render: () => <SettingsSwitch atom={showArrowsAtom} />,
      },
      {
        id: "variation-arrows",
        category: "board",
        title: t("Settings.VariationArrows"),
        description: t("Settings.VariationArrows.Desc"),
        keywords: ["arrows", "variations", "alternative"],
        render: () => <SettingsSwitch atom={showVariationArrowsAtom} />,
      },
      {
        id: "move-notation",
        category: "board",
        title: t("Settings.MoveNotation"),
        description: t("Settings.MoveNotation.Desc"),
        keywords: ["notation", "letters", "symbols", "pieces"],
        render: () => (
          <Select
            data={[
              { label: t("Settings.MoveNotation.Letters"), value: "letters" },
              { label: t("Settings.MoveNotation.Symbols"), value: "symbols" },
            ]}
            allowDeselect={false}
            value={moveNotationType}
            onChange={(val) => setMoveNotationType(val as "letters" | "symbols")}
          />
        ),
      },
      {
        id: "move-method",
        category: "board",
        title: t("Settings.MoveMethod"),
        description: t("Settings.MoveMethod.Desc"),
        keywords: ["drag", "click", "move", "pieces"],
        render: () => (
          <Select
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
      },
      {
        id: "snap-arrows",
        category: "board",
        title: t("Settings.SnapArrows"),
        description: t("Settings.SnapArrows.Desc"),
        keywords: ["arrows", "snap"],
        render: () => <SettingsSwitch atom={snapArrowsAtom} />,
      },
      {
        id: "consecutive-arrows",
        category: "board",
        title: t("Settings.ConsecutiveArrows"),
        description: t("Settings.ConsecutiveArrows.Desc"),
        keywords: ["arrows", "consecutive"],
        render: () => <SettingsSwitch atom={showConsecutiveArrowsAtom} />,
      },
      {
        id: "erase-drawables",
        category: "board",
        title: t("Settings.EraseDrawablesOnClick"),
        description: t("Settings.EraseDrawablesOnClick.Desc"),
        keywords: ["erase", "drawables", "click", "arrows"],
        render: () => <SettingsSwitch atom={eraseDrawablesOnClickAtom} />,
      },
      {
        id: "auto-promote",
        category: "board",
        title: t("Settings.AutoPromition"),
        description: t("Settings.AutoPromition.Desc"),
        keywords: ["promote", "queen", "pawn"],
        render: () => <SettingsSwitch atom={autoPromoteAtom} />,
      },
      {
        id: "coordinates",
        category: "board",
        title: t("Settings.Coordinates"),
        description: t("Settings.Coordinates.Desc"),
        keywords: ["coordinates", "a-h", "1-8"],
        render: () => (
          <Select
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
      },
      {
        id: "animation-speed",
        category: "board",
        title: t("Settings.AnimationSpeed"),
        description: t("Settings.AnimationSpeed.Desc"),
        keywords: ["animation", "speed", "duration", "move"],
        render: () => (
          <Select
            aria-label={t("Settings.AnimationSpeed")}
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
      },
      {
        id: "auto-save",
        category: "board",
        title: t("Settings.AutoSave"),
        description: t("Settings.AutoSave.Desc"),
        keywords: ["save", "auto"],
        render: () => <SettingsSwitch atom={autoSaveAtom} />,
      },
      {
        id: "preview-board",
        category: "board",
        title: t("Settings.PreviewBoard"),
        description: t("Settings.PreviewBoard.Desc"),
        keywords: ["preview", "hover"],
        render: () => <SettingsSwitch atom={previewBoardOnHoverAtom} />,
      },
      {
        id: "flip-board-after-move",
        category: "board",
        title: t("Settings.FlipBoardAfterMove"),
        description: t("Settings.FlipBoardAfterMove.Desc"),
        keywords: ["flip", "board", "move"],
        render: () => <SettingsSwitch atom={flipBoardAfterMoveAtom} />,
      },
      {
        id: "scroll-moves",
        category: "board",
        title: t("Settings.ScrollThroughMoves"),
        description: t("Settings.ScrollThroughMoves.Desc"),
        keywords: ["scroll", "moves", "wheel"],
        render: () => <SettingsSwitch atom={enableBoardScrollAtom} />,
      },
      {
        id: "choose-variation",
        category: "board",
        title: t("Settings.ChooseVariation"),
        description: t("Settings.ChooseVariation.Desc"),
        keywords: ["variation", "branch", "arrow", "keyboard", "continuation"],
        render: () => <SettingsSwitch atom={chooseVariationAtom} />,
      },
      {
        id: "material-display",
        category: "board",
        title: t("Settings.MaterialDisplay"),
        description: t("Settings.MaterialDisplay.Desc"),
        keywords: ["material", "captured", "pieces", "difference"],
        render: () => (
          <Select
            data={[
              { label: t("Settings.MaterialDisplay.Diff"), value: "diff" },
              { label: t("Settings.MaterialDisplay.All"), value: "all" },
            ]}
            allowDeselect={false}
            value={materialDisplay}
            onChange={(val) => setMaterialDisplay(val as "diff" | "all")}
          />
        ),
      },
      // Input settings
      {
        id: "text-input",
        category: "inputs",
        title: t("Settings.Inputs.TextInput"),
        description: t("Settings.Inputs.TextInput.Desc"),
        keywords: ["text", "input", "type"],
        render: () => <SettingsSwitch atom={moveInputAtom} />,
      },
      {
        id: "spell-check",
        category: "inputs",
        title: t("Settings.Inputs.SpellCheck"),
        description: t("Settings.Inputs.SpellCheck.Desc"),
        keywords: ["spell", "check", "grammar"],
        render: () => <SettingsSwitch atom={spellCheckAtom} />,
      },
      // Appearance settings
      {
        id: "theme",
        category: "appearance",
        title: t("Settings.Appearance.Theme"),
        description: t("Settings.Appearance.Theme.Desc"),
        keywords: ["theme", "dark", "light", "color"],
        render: () => <ThemeButton />,
      },
      {
        id: "language",
        category: "appearance",
        title: t("Settings.Appearance.Language"),
        description: t("Settings.Appearance.Language.Desc"),
        keywords: ["language", "locale", "translation"],
        render: () => (
          <Select
            aria-label={t("Settings.Appearance.Language")}
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
      },
      ...(import.meta.env.VITE_PLATFORM === "win32" || import.meta.env.VITE_PLATFORM === "linux"
        ? [
            {
              id: "title-bar",
              category: "appearance" as SettingCategory,
              title: t("Settings.Appearance.TitleBar"),
              description: t("Settings.Appearance.TitleBar.Desc"),
              keywords: ["title", "bar", "native", "custom"],
              render: () => (
                <Select
                  aria-label={t("Settings.Appearance.TitleBar")}
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
            },
          ]
        : []),
      {
        id: "font-size",
        category: "appearance",
        title: t("Settings.Appearance.FontSize"),
        description: t("Settings.Appearance.FontSize.Desc"),
        keywords: ["font", "size", "text"],
        render: () => (
          <PercentagePreferenceSlider
            atom={fontSizeAtom}
            min={FONT_SCALE_MIN}
            max={FONT_SCALE_MAX}
            step={FONT_SCALE_STEP}
            marks={FONT_SIZE_MARKS}
            thumbLabel={t("Settings.Appearance.FontSize")}
          />
        ),
      },
      {
        id: "piece-set",
        category: "appearance",
        title: t("Settings.Appearance.PieceSet"),
        description: t("Settings.Appearance.PieceSet.Desc"),
        keywords: ["piece", "set", "style"],
        render: () => <PiecesSelect />,
      },
      {
        id: "piece-size",
        category: "appearance",
        title: t("Settings.Appearance.PieceSize"),
        description: t("Settings.Appearance.PieceSize.Desc"),
        keywords: ["piece", "size", "scale"],
        render: () => (
          <PercentagePreferenceSlider
            atom={pieceSizeAtom}
            min={PIECE_SCALE_MIN}
            max={PIECE_SCALE_MAX}
            step={PIECE_SCALE_STEP}
            marks={PIECE_SIZE_MARKS}
            thumbLabel={t("Settings.Appearance.PieceSize")}
          />
        ),
      },
      {
        id: "board-image",
        category: "appearance",
        title: t("Settings.Appearance.BoardImage"),
        description: t("Settings.Appearance.BoardImage.Desc"),
        keywords: ["board", "image", "texture"],
        render: () => <BoardSelect />,
      },
      {
        id: "board-wood-texture",
        category: "appearance",
        title: t("Settings.Appearance.WoodTexture"),
        description: t("Settings.Appearance.WoodTexture.Desc"),
        keywords: ["wood", "texture", "grain", "board"],
        render: () => <SettingsSwitch atom={boardWoodTextureAtom} />,
      },
      // Repertoire settings
      {
        id: "repertoire-depth",
        category: "repertoire",
        title: t("Settings.Repertoire.Depth"),
        description: t("Settings.Repertoire.Depth.Desc"),
        keywords: ["repertoire", "depth", "games", "min"],
        render: () => <RepertoireMinGamesSetting />,
      },
      {
        id: "repertoire-auto-difficulty",
        category: "repertoire",
        title: t("Settings.Repertoire.AutoDifficulty"),
        description: t("Settings.Repertoire.AutoDifficulty.Desc"),
        keywords: ["repertoire", "auto", "difficulty", "select", "anki"],
        render: () => (
          <Select
            allowDeselect={false}
            data={[
              { label: t("Settings.Repertoire.AutoDifficulty.None"), value: "none" },
              { label: t("Board.Practice.Again"), value: "1" },
              { label: t("Board.Practice.Hard"), value: "2" },
              { label: t("Board.Practice.Good"), value: "3" },
              { label: t("Board.Practice.Easy"), value: "4" },
            ]}
            value={practiceAutoDifficulty}
            onChange={(val) => setPracticeAutoDifficulty(val as "none" | "1" | "2" | "3" | "4")}
          />
        ),
      },
      // Sound settings
      {
        id: "volume",
        category: "sound",
        title: t("Settings.Sound.Volume"),
        description: t("Settings.Sound.Volume.Desc"),
        keywords: ["volume", "audio", "loud"],
        render: () => <VolumeSlider />,
      },
      {
        id: "sound-collection",
        category: "sound",
        title: t("Settings.Sound.Collection"),
        description: t("Settings.Sound.Collection.Desc"),
        keywords: ["sound", "collection", "audio", "effects"],
        render: () => <SoundSelect />,
      },
      // Directories settings
      {
        id: "files-directory",
        category: "directories",
        title: t("Settings.Directories.Files"),
        description: t("Settings.Directories.Files.Desc"),
        keywords: ["files", "directory", "folder", "path"],
        render: () => (
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
      },
      {
        id: "databases-directory",
        category: "directories",
        title: t("Settings.Directories.Databases"),
        description: t("Settings.Directories.Databases.Desc"),
        keywords: ["databases", "directory", "folder", "path"],
        render: () => (
          <DirectorySetting
            value={databasesDirectory || null}
            issueWorkspace={async () => {
              await tauri.issueDatabaseWorkspace();
              return "Databases";
            }}
            onSelect={setDatabasesDirectory}
            onError={showDirectoryError}
          />
        ),
      },
      {
        id: "engines-directory",
        category: "directories",
        title: t("Settings.Directories.Engines"),
        description: t("Settings.Directories.Engines.Desc"),
        keywords: ["engines", "directory", "folder", "path"],
        render: () => (
          <DirectorySetting
            value={enginesDirectory}
            issueWorkspace={async () => {
              await tauri.issueEngineWorkspace();
              return "Engines";
            }}
            onSelect={setEnginesDirectory}
            onError={showDirectoryError}
          />
        ),
      },
      {
        id: "puzzles-directory",
        category: "directories",
        title: t("Settings.Directories.Puzzles"),
        description: t("Settings.Directories.Puzzles.Desc"),
        keywords: ["puzzles", "directory", "folder", "path"],
        render: () => (
          <DirectorySetting
            value={puzzleWorkspaceName}
            issueWorkspace={async () => (await tauri.issuePuzzleWorkspace()).displayName}
            onSelect={(name) => {
              setPuzzleWorkspaceName(name);
              setPuzzleWorkspaceGeneration((generation) => generation + 1);
            }}
            onError={showDirectoryError}
          />
        ),
      },
      // Privacy settings
      {
        id: "telemetry",
        category: "privacy",
        title: t("Settings.Privacy.Telemetry"),
        description: t("Settings.Privacy.Telemetry.Desc"),
        keywords: ["telemetry", "privacy", "analytics", "tracking"],
        render: () => <TelemetrySwitch />,
      },
    ],
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
      databasesDirectory,
      enginesDirectory,
      puzzleWorkspaceName,
      setMoveNotationType,
      setMoveMethod,
      setIsNative,
      setFileWorkspace,
      setFileWorkspaceDisplayName,
      setDatabasesDirectory,
      setEnginesDirectory,
      setPuzzleWorkspaceGeneration,
      setShowCoordinates,
      setAnimationSpeed,
      setMaterialDisplay,
      practiceAutoDifficulty,
      setPracticeAutoDifficulty,
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
      privacy: {
        title: t("Settings.Privacy"),
        description: t("Settings.Privacy.Desc"),
        icon: <Shield size="1rem" />,
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
        setting.keywords?.some((kw) => kw.toLowerCase().includes(query)),
    );
  }, [searchQuery, settings, categoryInfo]);

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
      {} as Record<SettingCategory, SettingItem[]>,
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
              <SettingRow key={setting.id} title={setting.title} description={setting.description}>
                {setting.render()}
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
      <SettingRow key={setting.id} title={setting.title} description={setting.description}>
        {setting.render()}
      </SettingRow>
    ));
  };

  return (
    <Stack h="100%" gap={0} data-compact={compactTabs || undefined}>
      <Group px="md" pt="md" pb="sm" className={classes.searchRow}>
        <Title order={1} size="h3" className="wrap-anywhere" miw={0}>
          {t("SideBar.Settings")}
        </Title>
        <TextInput
          ref={searchInputRef}
          placeholder={t("Common.Search")}
          leftSection={<Search size="1rem" />}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.currentTarget.value)}
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
          defaultValue="board"
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
            <Tabs.Tab value="board" leftSection={<ChessKnight size="1rem" />}>
              {t("Settings.Board")}
            </Tabs.Tab>
            <Tabs.Tab value="inputs" leftSection={<Mouse size="1rem" />}>
              {t("Settings.Inputs")}
            </Tabs.Tab>
            <Tabs.Tab value="appearance" leftSection={<Palette size="1rem" />}>
              {t("Settings.Appearance")}
            </Tabs.Tab>
            <Tabs.Tab value="sound" leftSection={<Volume2 size="1rem" />}>
              {t("Settings.Sound")}
            </Tabs.Tab>
            <Tabs.Tab value="keybinds" leftSection={<Keyboard size="1rem" />}>
              {t("Settings.Keybinds")}
            </Tabs.Tab>
            <Tabs.Tab value="directories" leftSection={<Folder size="1rem" />}>
              {t("Settings.Directories")}
            </Tabs.Tab>
            <Tabs.Tab value="repertoire" leftSection={<BookOpen size="1rem" />}>
              {t("Settings.Repertoire")}
            </Tabs.Tab>
            <Tabs.Tab value="privacy" leftSection={<Shield size="1rem" />}>
              {t("Settings.Privacy")}
            </Tabs.Tab>
          </Tabs.List>
          <Stack flex={1} className={classes.settingsContent}>
            <ScrollArea className={classes.settingsScroll}>
              <Card withBorder className={`${classes.card} wrap-anywhere`} w="100%">
                <Tabs.Panel value="board">
                  <Text size="lg" fw={500} className={classes.title}>
                    {t("Settings.Board")}
                  </Text>
                  <Text size="xs" c="dimmed" mt={3} mb="lg">
                    {t("Settings.Board.Desc")}
                  </Text>
                  {renderCategorySettings("board")}
                </Tabs.Panel>

                <Tabs.Panel value="inputs">
                  <Text size="lg" fw={500} className={classes.title}>
                    {t("Settings.Inputs")}
                  </Text>
                  <Text size="xs" c="dimmed" mt={3} mb="lg">
                    {t("Settings.Inputs.Desc")}
                  </Text>
                  {renderCategorySettings("inputs")}
                </Tabs.Panel>

                <Tabs.Panel value="appearance">
                  <Text size="lg" fw={500} className={classes.title}>
                    {t("Settings.Appearance")}
                  </Text>
                  <Text size="xs" c="dimmed" mt={3} mb="lg">
                    {t("Settings.Appearance.Desc")}
                  </Text>
                  {renderCategorySettings("appearance")}
                </Tabs.Panel>

                <Tabs.Panel value="sound">
                  <Text size="lg" fw={500} className={classes.title}>
                    {t("Settings.Sound")}
                  </Text>
                  <Text size="xs" c="dimmed" mt={3} mb="lg">
                    {t("Settings.Sound.Desc")}
                  </Text>
                  {renderCategorySettings("sound")}
                </Tabs.Panel>

                <Tabs.Panel value="keybinds">
                  <Group>
                    <Text size="lg" fw={500} className={classes.title}>
                      {t("Settings.Keybinds")}
                    </Text>
                    <IconAction label={t("Common.Reset")} onClick={() => setKeyMap(RESET)}>
                      <RotateCcw size="1rem" />
                    </IconAction>
                  </Group>
                  <Text size="xs" c="dimmed" mt={3} mb="lg">
                    {t("Settings.Keybinds.Desc")}
                  </Text>
                  <Table>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{t("Common.Description")}</Table.Th>
                        <Table.Th>{t("Settings.Key")}</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {Object.entries(keyMap).map(([action, keybind]) => {
                        return (
                          <Table.Tr key={keybind.name}>
                            <Table.Td>{keybind.name}</Table.Td>
                            <Table.Td>
                              <KeybindInput action={action} keybind={keybind} />
                            </Table.Td>
                          </Table.Tr>
                        );
                      })}
                    </Table.Tbody>
                  </Table>
                </Tabs.Panel>

                <Tabs.Panel value="directories">
                  <Text size="lg" fw={500} className={classes.title}>
                    {t("Settings.Directories")}
                  </Text>
                  <Text size="xs" c="dimmed" mt={3} mb="lg">
                    {t("Settings.Directories.Desc")}
                  </Text>
                  {renderCategorySettings("directories")}
                </Tabs.Panel>

                <Tabs.Panel value="repertoire">
                  <Text size="lg" fw={500} className={classes.title}>
                    {t("Settings.Repertoire")}
                  </Text>
                  <Text size="xs" c="dimmed" mt={3} mb="lg">
                    {t("Settings.Repertoire.Desc")}
                  </Text>
                  {renderCategorySettings("repertoire")}
                </Tabs.Panel>

                <Tabs.Panel value="privacy">
                  <Text size="lg" fw={500} className={classes.title}>
                    {t("Settings.Privacy")}
                  </Text>
                  <Text size="xs" c="dimmed" mt={3} mb="lg">
                    {t("Settings.Privacy.Desc")}
                  </Text>
                  {renderCategorySettings("privacy")}
                </Tabs.Panel>
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
