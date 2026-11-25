import { tauri } from "@/platform/tauri";
import { Box, Divider, Group, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { LibraryTypeBadge } from "@/components/library/presentation";
import { libraryGamePositionAtom } from "@/components/library/memory";
import { Pencil } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useAtom, useStore } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useElementSize } from "@mantine/hooks";
import { useTranslation } from "react-i18next";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { tabsAtom } from "@/state/atoms";
import { StaleFileGameError } from "@/state/fileStructureChange";
import { rootFontPx } from "@/state/paneLayout";
import { IconAction } from "@/components/common/IconAction";
import { OpenGameButton, useGameOpen } from "@/components/common/gameOpen";
import NewGameButton from "@/components/boards/NewGameButton";
import { openFile } from "@/utils/openFile";
import { runTabCreation } from "@/utils/tabs";
import { capitalize, formatNumber } from "@/utils/format";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import { normalizeError } from "@/platform/errors";
import {
  advanceRowsAfterTagWrite,
  certainWriteIdentity,
  fileGameHasBlockingOpenTab,
} from "@/utils/fileGameWrite";
import { readFileGame, setFileGameOrientation } from "@/utils/files";
import GamePreview from "../databases/GamePreview";
import GameSelector, { type GameSelectorRow } from "../panels/info/GameSelector";
import type { FileMetadata } from "./file";
import { reorderFileLines, type MoveLines } from "./reorderLines";
import classes from "./FileCard.module.css";

// Below this card width the preview's move list has no room beside the board, and the action row
// stacks Open game, New game, and the pencil. In rem, because both needs grow with the font scale
// while a window width in px does not.
const PREVIEW_CONTROLS_MIN_WIDTH_REM = 26;
const GAME_LIST_MIN_HEIGHT = "8rem";

// The parent keys this card by the handle key, so a different file remounts its game-name cache.
function FileCard({
  selected,
  onEditMetadata,
  omitNewGame = false,
}: {
  selected: FileMetadata;
  onEditMetadata: () => void;
  // The LinkedCollection panel above the card owns New game for that file.
  omitNewGame?: boolean;
}) {
  const { t } = useTranslation();

  const [tabs, setTabs] = useAtom(tabsAtom);
  const workspace = useStore();
  const navigate = useNavigate();

  const [selectedGame, setSelectedGame] = useState<string | null>(null);
  const [previewIdentity, setPreviewIdentity] = useState<{
    index: number;
    stamp: string;
    revision: string;
  } | null>(null);
  const [previewOmitted, setPreviewOmitted] = useState(false);
  const [loadedPreviewIndex, setLoadedPreviewIndex] = useState<number | null>(null);
  const [position, setPosition] = useAtom(libraryGamePositionAtom);
  const [games, setGames] = useState<Map<number, GameSelectorRow>>(new Map());
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Two handles with the same key are the same file, so a new handle object must not retrigger the read.
  const handleRef = useRef(selected.handle);
  handleRef.current = selected.handle;
  const handleKey = fileWorkspaceKey(selected.handle);
  const page =
    position?.key === handleKey ? Math.min(position.index, Math.max(0, selected.numGames - 1)) : 0;
  const setPage = (index: number) => setPosition({ key: handleKey, index });
  const { ref: cardRef, width: cardWidth } = useElementSize();
  // Preserve this card's 16px fallback regardless of the configured font scale.
  const rootFont = rootFontPx(getComputedStyle(document.documentElement).fontSize, 100);
  const narrow = cardWidth < PREVIEW_CONTROLS_MIN_WIDTH_REM * rootFont;

  // Keyed by the handle, not the entry object: a relisting must not re-read the same file.
  useEffect(() => {
    const controller = new AbortController();
    async function loadGames() {
      try {
        const data = await tauri.readGames(handleRef.current, page, page, {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          const omitted = data[0]?.omission === "tooLarge";
          const game = data[0];
          const pgn = omitted ? null : (game?.pgn ?? null);
          setPreviewOmitted(omitted);
          setSelectedGame(pgn);
          setLoadedPreviewIndex(pgn === null ? null : page);
          setPreviewIdentity(
            omitted || !game?.pgn || !game.stamp || !game.revision
              ? null
              : { index: page, stamp: game.stamp, revision: game.revision },
          );
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setSelectedGame(null);
        setPreviewIdentity(null);
        setPreviewOmitted(false);
        setLoadedPreviewIndex(null);
        notifyUnlessCancelled(t("Common.Error"), error);
      }
    }
    void loadGames();
    return () => {
      controller.abort();
    };
  }, [handleKey, page, t, reloadGeneration]);

  const reloadGames = useCallback((reset: boolean) => {
    if (!mounted.current) return;
    if (reset) setGames(new Map());
    setReloadGeneration((previous) => previous + 1);
  }, []);
  const persistPreviewOrientation = useCallback(
    async (side: "white" | "black") => {
      const identity = previewIdentity;
      const gameNumber = page;
      const handle = selected.handle;
      const showStale = () => {
        notifications.show({
          color: "danger",
          title: t("Common.Error"),
          message: t("Files.LineSection.Stale", {
            defaultValue: "The file changed. Check the list and try again.",
          }),
        });
        reloadGames(false);
      };
      if (!identity || identity.index !== gameNumber) {
        showStale();
        throw new Error("stale preview");
      }
      if (fileGameHasBlockingOpenTab(tabs, handle, gameNumber)) {
        notifications.show({
          color: "danger",
          title: t("Common.Error"),
          message: t("Files.LineSection.UnsavedTab", {
            defaultValue: "Save or close this game's open tab first.",
          }),
        });
        throw new Error("unsaved tab");
      }
      let current;
      try {
        current = await readFileGame(handle, gameNumber);
      } catch (error) {
        if (mounted.current) notifyUnlessCancelled(t("Common.Error"), error);
        throw error;
      }
      if (!current.present || current.omission || current.stamp !== identity.stamp) {
        if (mounted.current) showStale();
        throw new Error("stale preview");
      }
      try {
        const written = await setFileGameOrientation(
          handle,
          gameNumber,
          side,
          current.stamp,
          current.revision,
        );
        if (!mounted.current) return;
        const confirmed = certainWriteIdentity(written);
        if (!confirmed) {
          reloadGames(false);
          return;
        }
        setPreviewIdentity((previous) =>
          previous?.index === gameNumber ? { ...previous, ...confirmed } : previous,
        );
        setGames((previous) =>
          advanceRowsAfterTagWrite(previous, gameNumber, confirmed, current.revision),
        );
      } catch (error) {
        if (!mounted.current) throw error;
        const details = normalizeError(error);
        if (details.backendCategory === "stale-game") {
          showStale();
        } else {
          if (details.category === "applied-despite-error") reloadGames(false);
          notifyUnlessCancelled(t("Common.Error"), error);
        }
        throw error;
      }
    },
    [page, previewIdentity, reloadGames, selected.handle, t, tabs],
  );
  const onMoveLines: MoveLines = async (movement, revision) => {
    try {
      return await reorderFileLines({
        file: selected,
        movement,
        revision,
        rows: games,
        workspace,
        setTabs,
        getSelection: () => {
          const current = workspace.get(libraryGamePositionAtom);
          return current?.key === handleKey ? current.index : 0;
        },
        select: (index) => {
          workspace.set(libraryGamePositionAtom, (current) =>
            current?.key === handleKey || (mounted.current && current === null)
              ? { key: handleKey, index }
              : current,
          );
        },
        reload: reloadGames,
      });
    } catch (error) {
      notifyUnlessCancelled(t("Common.Error"), error);
      return undefined;
    }
  };

  const reportOpenError = (error: unknown) => {
    if (error instanceof StaleFileGameError) reloadGames(false);
    notifyUnlessCancelled(t("Common.Error"), error);
  };
  const gameOpen = useGameOpen(
    ({
      file,
      index,
      expected,
    }: {
      file: FileMetadata;
      index: number;
      expected?: GameSelectorRow["identity"];
    }) =>
      runTabCreation({
        create: () => openFile(file, setTabs, { gameNumber: index, expected, fromPreview: true }),
        onSuccess: () => navigate({ to: "/" }),
        onError: reportOpenError,
      }),
    reportOpenError,
  );
  const activateGame = (index: number) => {
    if (index < 0 || index >= selected.numGames) return;
    setPage(index);
    return gameOpen.activate({ file: selected, index, expected: games.get(index)?.identity });
  };

  const openGame = (
    <OpenGameButton
      onOpen={() => activateGame(page)}
      pending={gameOpen.pending}
      disabled={previewOmitted || selected.numGames <= 0 || page >= selected.numGames}
      fullWidth={narrow}
    />
  );
  const newGame = !omitNewGame && (
    <NewGameButton
      origin={{ kind: "fileDraft", file: selected }}
      explanation={t("Files.NewGame.Desc", {
        defaultValue: "Enter a new game move by move and save it to this file.",
      })}
      fullWidth={narrow}
    />
  );
  const edit = (
    <IconAction label={t("Files.EditMetadata")} size="sm" onClick={onEditMetadata}>
      <Pencil size="1rem" />
    </IconAction>
  );
  const gameCount = (
    <Text ta="center" c="dimmed" miw={0}>
      {t("Files.GameCountSuffix", {
        count: selected.numGames,
        number: formatNumber(selected.numGames),
      })}
    </Text>
  );

  return (
    <Stack h="100%" miw={0} w="100%" ref={cardRef}>
      <Stack align="center" className={classes.header}>
        <Text ta="center" fz="xl" fw="bold" miw={0} style={{ overflowWrap: "anywhere" }}>
          {selected?.name}
        </Text>
        <LibraryTypeBadge size="md">
          {t(`Files.FileType.${capitalize(selected.metadata.type)}`)}
        </LibraryTypeBadge>
      </Stack>
      <Divider />

      {narrow ? (
        <Stack gap="xs" px={{ base: 0, lg: "xs" }} className={classes.stacked}>
          {openGame}
          {newGame}
          <Group gap="xs" wrap="wrap">
            {edit}
            {gameCount}
          </Group>
        </Stack>
      ) : (
        <Group
          align="center"
          justify="space-between"
          wrap="wrap"
          px={{ base: 0, lg: "xs" }}
          miw={0}
        >
          <Group gap="xs" wrap="wrap" miw={0}>
            {openGame}
            {newGame}
            {edit}
          </Group>
          {gameCount}
        </Group>
      )}

      {/* When both parts render, they share what the header leaves, by ratio, from a zero basis:
          a fixed preview share once left the list two rows in a short window. The floor keeps ~4 rows. */}
      {selected.numGames > 0 && (
        <Box flex="2 1 0" mih={GAME_LIST_MIN_HEIGHT}>
          <Divider />
          <GameSelector
            setGames={setGames}
            games={games}
            activePage={page}
            revealActivePage
            path={selected.handle}
            setPage={setPage}
            onActivate={activateGame}
            total={selected.numGames}
            repertoire={selected.metadata.type === "repertoire"}
            editableSections={selected.metadata.type === "repertoire"}
            onMoveLines={selected.metadata.type === "repertoire" ? onMoveLines : undefined}
            reloadGeneration={reloadGeneration}
          />
          <Divider />
        </Box>
      )}
      {/* Reserve the preview's share while reading so the list never moves between clicks. */}
      {selected.numGames > 0 && (
        <Box flex="3 1 0" mih={0} px="xs" pb="xs">
          {previewOmitted && <Text>{t("Files.GameTooLarge")}</Text>}
          {selectedGame !== null && loadedPreviewIndex !== null && (
            <GamePreview
              key={loadedPreviewIndex}
              pgn={selectedGame}
              hideControls={narrow}
              fitHeight
              persistOrientation={persistPreviewOrientation}
            />
          )}
        </Box>
      )}
    </Stack>
  );
}

export default FileCard;
