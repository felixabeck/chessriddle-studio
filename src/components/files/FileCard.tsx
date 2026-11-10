import { tauri } from "@/platform/tauri";
import { Box, Divider, Group, Stack, Text } from "@mantine/core";
import { LibraryTypeBadge } from "@/components/library/presentation";
import { libraryGamePositionAtom } from "@/components/library/memory";
import { Pencil } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useAtom, useStore } from "jotai";
import { useEffect, useRef, useState } from "react";
import { useElementSize } from "@mantine/hooks";
import { useTranslation } from "react-i18next";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { tabsAtom } from "@/state/atoms";
import { StaleFileGameError } from "@/state/fileStructureChange";
import { rootFontPx } from "@/state/paneLayout";
import { IconAction } from "@/components/common/IconAction";
import { OpenGameButton, useGameOpen } from "@/components/common/gameOpen";
import { openFile } from "@/utils/files";
import { runTabCreation } from "@/utils/tabs";
import { capitalize, formatNumber } from "@/utils/format";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import GamePreview from "../databases/GamePreview";
import GameSelector, { type GameSelectorRow } from "../panels/info/GameSelector";
import type { FileMetadata } from "./file";
import { reorderFileLines, type MoveLines } from "./reorderLines";

// Below this card width the preview's move list has no room beside the board. In rem, because the
// list's needs grow with the font scale while a window width in px does not.
const PREVIEW_CONTROLS_MIN_WIDTH_REM = 26;
const GAME_LIST_MIN_HEIGHT = "8rem";

// The parent keys this card by the handle key, so a different file remounts its game-name cache.
function FileCard({
  selected,
  onEditMetadata,
}: {
  selected: FileMetadata;
  onEditMetadata: () => void;
}) {
  const { t } = useTranslation();

  const [, setTabs] = useAtom(tabsAtom);
  const workspace = useStore();
  const navigate = useNavigate();

  const [selectedGame, setSelectedGame] = useState<string | null>(null);
  const [previewOmitted, setPreviewOmitted] = useState(false);
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
          setPreviewOmitted(omitted);
          setSelectedGame(omitted ? null : (data[0]?.pgn ?? null));
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setSelectedGame(null);
        setPreviewOmitted(false);
        notifyUnlessCancelled(t("Common.Error"), error);
      }
    }
    void loadGames();
    return () => {
      controller.abort();
    };
  }, [handleKey, page, t, reloadGeneration]);

  const reloadGames = (reset: boolean) => {
    if (!mounted.current) return;
    if (reset) setGames(new Map());
    setReloadGeneration((previous) => previous + 1);
  };
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
        create: () => openFile(file, setTabs, { gameNumber: index, expected }),
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

  return (
    <Stack h="100%" ref={cardRef}>
      <Stack align="center">
        <Text ta="center" fz="xl" fw="bold" miw={0} style={{ overflowWrap: "anywhere" }}>
          {selected?.name}
        </Text>
        <LibraryTypeBadge size="md">
          {t(`Files.FileType.${capitalize(selected.metadata.type)}`)}
        </LibraryTypeBadge>
      </Stack>
      <Divider />

      <Group align="center" justify="space-between" wrap="wrap" px={{ base: 0, lg: "xs" }} miw={0}>
        <Group gap="xs" miw={0}>
          <OpenGameButton
            onOpen={() => activateGame(page)}
            pending={gameOpen.pending}
            disabled={previewOmitted || selected.numGames <= 0 || page >= selected.numGames}
          />
          <IconAction label={t("Files.EditMetadata")} size="sm" onClick={onEditMetadata}>
            <Pencil size="1rem" />
          </IconAction>
        </Group>
        <Text ta="center" c="dimmed" miw={0}>
          {t("Files.GameCountSuffix", {
            count: selected.numGames,
            number: formatNumber(selected.numGames),
          })}
        </Text>
      </Group>

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
          {selectedGame !== null && (
            <GamePreview pgn={selectedGame} hideControls={narrow} fitHeight />
          )}
        </Box>
      )}
    </Stack>
  );
}

export default FileCard;
