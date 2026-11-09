import { tauri } from "@/platform/tauri";
import { Box, Group, ScrollArea, Text } from "@mantine/core";
import { useToggle } from "@mantine/hooks";
import { SeparatorHorizontal, Trash2 } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import cx from "clsx";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FileWorkspaceHandle, StampedGame } from "@/bindings";
import ConfirmModal from "@/components/common/ConfirmModal";
import { IconAction } from "@/components/common/IconAction";
import { gameRowActivation } from "@/components/common/gameOpen";
import { lineSectionOf } from "@/components/files/lineSection";
import type { MoveLines } from "@/components/files/reorderLines";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { useVirtualPageLoader } from "@/hooks/useVirtualPageLoader";
import { errorUnlessCancelled } from "@/platform/errors";
import { fontSizeAtom } from "@/state/atoms";
import { parsePGN } from "@/utils/chess";
import { formatNumber } from "@/utils/format";
import { getGameName } from "@/utils/treeReducer";
import classes from "./GameSelector.module.css";
import LineSectionEditor, { type LineSectionTarget } from "./LineSectionEditor";
import { attachLineDragController } from "./lineDragController";

// Opening load count; the requested end index is inclusive.
const INITIAL_LOAD_ROWS = 11;
// Row height at 100 % font size.
const ROW_HEIGHT_PX = 30;
// Space a section adds above its first line at 100 % font size.
const SECTION_GAP_PX = 12;
const SECTION_HEADING_PX = 26;

export type GameSelectorRow = {
  name: string;
  /** Absent for a line inside a section, empty for a section without a name. */
  section?: string;
  omission?: StampedGame["omission"];
  identity?: Pick<StampedGame, "stamp" | "revision">;
};

export type DeleteGameSnapshot = { index: number; stamp: string; revision: string };

type DeleteGame = (snapshot: DeleteGameSnapshot) => void | Promise<void>;

function sectionSpacePx(section: string | undefined, index: number) {
  if (section === undefined) return 0;
  // The first line needs no gap above it, and an unnamed section there has nothing to show.
  return (index === 0 ? 0 : SECTION_GAP_PX) + (section === "" ? 0 : SECTION_HEADING_PX);
}

export default function GameSelector({
  games,
  setGames,
  setPage,
  total,
  path,
  activePage,
  deleteGame,
  onActivate,
  editableSections = false,
  revealActivePage = false,
  reloadGeneration = 0,
  onMoveLines,
}: {
  games: Map<number, GameSelectorRow>;
  setGames: React.Dispatch<React.SetStateAction<Map<number, GameSelectorRow>>>;
  setPage: (v: number) => void;
  total: number;
  path: FileWorkspaceHandle;
  activePage: number;
  deleteGame?: DeleteGame;
  onActivate?: (index: number) => void | Promise<void>;
  editableSections?: boolean;
  revealActivePage?: boolean;
  onMoveLines?: MoveLines;
  reloadGeneration?: number;
}) {
  const { t } = useTranslation();
  const [sectionTarget, setSectionTarget] = useState<LineSectionTarget | null>(null);
  const listGeneration = useRef(reloadGeneration);
  listGeneration.current = reloadGeneration;
  const reloading = useRef(false);
  const loadPage = useCallback(
    async (startIndex: number, stopIndex: number, options?: { signal?: AbortSignal }) => {
      const generation = listGeneration.current;
      try {
        const entries: (readonly [number, GameSelectorRow])[] = [];
        let next = startIndex;
        while (next <= stopIndex && !options?.signal?.aborted) {
          const data = await tauri.readGames(path, next, Math.min(stopIndex, next + 999), options);
          if (data.length === 0) break;
          const page = await Promise.all(
            data.map(async (game, index) => {
              if (game.omission === "tooLarge") {
                return [
                  next + index,
                  { name: t("Files.GameTooLarge"), omission: game.omission },
                ] as const;
              }
              try {
                const { headers } = await parsePGN(game.pgn, undefined, options);
                return [
                  next + index,
                  {
                    name: getGameName(headers),
                    section: lineSectionOf(headers),
                    identity: game.present
                      ? { stamp: game.stamp, revision: game.revision }
                      : undefined,
                  },
                ] as const;
              } catch (error) {
                if (options?.signal?.aborted || errorUnlessCancelled(error) === null) {
                  throw error;
                }
                return [next + index, { name: t("Files.GameUnreadable") }] as const;
              }
            }),
          );
          entries.push(...page);
          next += page.length;
        }
        return generation === listGeneration.current ? entries : [];
      } catch (error) {
        if (!options?.signal?.aborted) notifyUnlessCancelled(t("Common.Error"), error);
        return [];
      }
    },
    [path, t],
  );
  const loadMoreRows = useVirtualPageLoader(
    `${path.id.id}:${reloadGeneration}`,
    loadPage,
    (startIndex, entries) => {
      if (reloading.current) return;
      setGames((previous) => {
        if (entries.length === 0) return previous;
        const next = new Map(previous);
        for (const [index, name] of entries) next.set(index, name);
        return next;
      });
    },
  );

  const fontSize = useAtomValue(fontSizeAtom);

  const parentRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dragSnapshot = useRef({ games, total, onMoveLines });
  dragSnapshot.current = { games, total, onMoveLines };
  const hasRows = games.size > 0;
  const canMove = !!onMoveLines;
  useEffect(() => {
    if (!canMove || !hasRows || !listRef.current || !parentRef.current) return;
    return attachLineDragController({
      list: listRef.current,
      viewport: parentRef.current,
      snapshot: () => ({
        rows: dragSnapshot.current.games,
        total: dragSnapshot.current.total,
        available: !reloading.current,
      }),
      move: (movement, revision) => {
        void dragSnapshot.current
          .onMoveLines?.(movement, revision)
          .catch((error) => notifyUnlessCancelled(t("Common.Error"), error));
      },
    });
  }, [canMove, hasRows, path.id.id, reloadGeneration, total, t]);
  const rowVirtualizer = useVirtualizer({
    count: total,
    estimateSize: (index) =>
      (ROW_HEIGHT_PX + sectionSpacePx(games.get(index)?.section, index)) * (fontSize / 100),
    getScrollElement: () => parentRef.current!,
  });
  const sectionLayout = Array.from(games)
    .filter(([, game]) => game.section !== undefined)
    .map(([index, game]) => `${index}:${sectionSpacePx(game.section, index)}`)
    .join();
  // The virtualizer caches row sizes, so a row that gains or loses a section must be measured again.
  useEffect(() => {
    rowVirtualizer.measure();
  }, [fontSize, rowVirtualizer, sectionLayout]);
  const virtualItems = rowVirtualizer.getVirtualItems();
  // React Virtual returns a fresh array on each read.  Effects depend only on
  // this stable primitive range, not on the ephemeral array/getter result.
  const visibleStart = virtualItems[0]?.index ?? -1;
  const visibleEnd = virtualItems.at(-1)?.index ?? -1;
  const reloadRows = useRef({ games, visibleStart, visibleEnd });
  reloadRows.current = { games, visibleStart, visibleEnd };
  useEffect(() => {
    if (reloadGeneration === 0) return;
    const controller = new AbortController();
    const generation = reloadGeneration;
    const snapshot = reloadRows.current;
    const indices = new Set(snapshot.games.keys());
    for (
      let index = Math.max(0, snapshot.visibleStart);
      index <= Math.min(total - 1, Math.max(0, snapshot.visibleEnd));
      index += 1
    )
      indices.add(index);
    const ordered = Array.from(indices)
      .filter((index) => index < total)
      .sort((a, b) => a - b);
    reloading.current = true;
    const reload = async () => {
      const rows = new Map<number, GameSelectorRow>();
      for (let at = 0; at < ordered.length && !controller.signal.aborted; at += 1) {
        const start = ordered[at];
        while (at + 1 < ordered.length && ordered[at + 1] === ordered[at] + 1) at += 1;
        for (const [index, row] of await loadPage(start, ordered[at], {
          signal: controller.signal,
        }))
          rows.set(index, row);
      }
      return rows;
    };
    void reload().then((rows) => {
      if (controller.signal.aborted || listGeneration.current !== generation) return;
      reloading.current = false;
      setGames(rows);
    });
    return () => {
      controller.abort();
      reloading.current = false;
    };
  }, [reloadGeneration, path.id.id, total, loadPage, setGames]);

  const reveal = useRef(revealActivePage);
  if (reloadGeneration > 0) reveal.current = false;
  // Use a single offset write, without scrollToIndex's queued retries, so user scrolling wins.
  useEffect(() => {
    if (!revealActivePage || !reveal.current) return;
    const offset = rowVirtualizer.getOffsetForIndex(activePage, "auto");
    if (offset) rowVirtualizer.scrollToOffset(offset[0]);
  }, [
    revealActivePage,
    activePage,
    sectionLayout,
    fontSize,
    rowVirtualizer,
    visibleStart,
    visibleEnd,
  ]);
  const stopReveal = () => {
    reveal.current = false;
  };

  useEffect(() => {
    if (games.size === 0) {
      void loadMoreRows(0, Math.min(INITIAL_LOAD_ROWS - 1, total - 1));
    }
    if (visibleStart >= 0 && visibleEnd >= visibleStart) {
      let hasUnloadedRow = false;
      for (let index = visibleStart; index <= visibleEnd; index += 1) {
        if (!games.has(index)) {
          hasUnloadedRow = true;
          break;
        }
      }
      if (hasUnloadedRow) void loadMoreRows(visibleStart, visibleEnd);
    }
  }, [games, loadMoreRows, total, visibleStart, visibleEnd]);

  return (
    <ScrollArea
      viewportRef={parentRef}
      h="100%"
      onWheelCapture={stopReveal}
      onTouchMoveCapture={stopReveal}
      onPointerDownCapture={stopReveal}
      onKeyDownCapture={stopReveal}
      onFocusCapture={stopReveal}
    >
      <Box
        ref={listRef}
        role="listbox"
        aria-label={t("Common.Games")}
        style={{
          height: rowVirtualizer.getTotalSize(),
          width: "100%",
          position: "relative",
        }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => (
          <GameRow
            key={virtualRow.index}
            index={virtualRow.index}
            game={games.get(virtualRow.index)}
            setPage={setPage}
            deleteGame={deleteGame}
            activePage={activePage}
            onActivate={onActivate}
            rowHeight={ROW_HEIGHT_PX * (fontSize / 100)}
            onSectionMenu={editableSections ? setSectionTarget : undefined}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: virtualRow.size,
              transform: `translateY(${virtualRow.start}px)`,
            }}
          />
        ))}
      </Box>
      {sectionTarget && (
        <LineSectionEditor
          file={path}
          target={sectionTarget}
          onClose={() => setSectionTarget(null)}
          onRefresh={() => setGames(new Map())}
          onSaved={(index, section, written) => {
            if (!written.stamp || !written.revision) {
              setGames(new Map());
              return;
            }
            const { stamp, revision } = written;
            // This write moved the file on by one revision and changed only this line, so rows
            // read at the edited revision are still current. An older row must stay refused.
            setGames(
              (previous) =>
                new Map(
                  Array.from(previous, ([rowIndex, row]) => [
                    rowIndex,
                    rowIndex === index
                      ? { ...row, section, identity: { stamp, revision } }
                      : row.identity?.revision === sectionTarget.revision
                        ? { ...row, identity: { ...row.identity, revision } }
                        : row,
                  ]),
                ),
            );
          }}
        />
      )}
    </ScrollArea>
  );
}

function GameRow({
  style,
  index,
  game,
  setPage,
  activePage,
  deleteGame,
  onActivate,
  rowHeight,
  onSectionMenu,
}: {
  style?: React.CSSProperties;
  index: number;
  game: GameSelectorRow | undefined;
  setPage: (v: number) => void;
  activePage: number;
  deleteGame?: DeleteGame;
  onActivate?: (index: number) => void | Promise<void>;
  rowHeight: number;
  onSectionMenu?: (target: LineSectionTarget) => void;
}) {
  const { t } = useTranslation();
  const [deleteModal, toggleDelete] = useToggle();
  const [deleteSnapshot, setDeleteSnapshot] = useState<DeleteGameSnapshot | null>(null);
  const canDelete = !!game?.identity?.stamp && !!game.identity.revision;
  const omitted = game?.omission === "tooLarge";
  const section = game?.section;
  const identity = game?.identity;
  const openSectionEditor =
    onSectionMenu && identity
      ? (x: number, y: number, nameFirst: boolean) =>
          onSectionMenu({
            index,
            section,
            stamp: identity.stamp,
            revision: identity.revision,
            x,
            y,
            nameFirst,
          })
      : undefined;

  return (
    <div
      role="presentation"
      className={classes.slot}
      data-line-index={index}
      style={style}
      onContextMenu={
        openSectionEditor
          ? (event) => {
              event.preventDefault();
              const bounds = event.currentTarget.getBoundingClientRect();
              const keyboard = event.clientX === 0 && event.clientY === 0;
              openSectionEditor(
                keyboard ? bounds.left : event.clientX,
                keyboard ? bounds.bottom : event.clientY,
                false,
              );
            }
          : undefined
      }
    >
      {deleteGame && (
        <ConfirmModal
          title={t("Files.RemoveGame")}
          description={t("Files.RemoveGameConfirm")}
          opened={deleteModal}
          onClose={() => {
            toggleDelete(false);
            setDeleteSnapshot(null);
          }}
          onConfirm={() => {
            if (!deleteSnapshot) throw new Error("Deletion confirmation has no game snapshot");
            return deleteGame(deleteSnapshot);
          }}
        />
      )}
      {section !== undefined && (
        <div className={classes.section} data-line-part="section">
          {section && (
            <Text fz="sm" fw={600} truncate>
              {section}
            </Text>
          )}
        </div>
      )}
      <Group
        data-line-part="line"
        role="option"
        aria-selected={index === activePage}
        aria-description={section || undefined}
        {...(omitted ? {} : gameRowActivation(index, onActivate ?? setPage))}
        style={{ height: rowHeight, flex: "none" }}
        justify="space-between"
        wrap="nowrap"
        gap="xs"
        className={cx(classes.row, {
          [classes.active]: index === activePage,
        })}
        onClick={() => {
          if (omitted) return;
          setPage(index);
        }}
      >
        <Text fz="xs" className={classes.index}>
          {formatNumber(index + 1)}
        </Text>
        <Text fz="sm" truncate flex={1} lh="sm">
          {game?.name || "..."}
        </Text>
        {deleteGame && (
          <IconAction
            label={t("Files.RemoveGame")}
            disabled={!canDelete}
            onClick={(event) => {
              event.stopPropagation();
              if (!game?.identity) return;
              setDeleteSnapshot({ index, ...game.identity });
              toggleDelete(true);
            }}
            variant="subtle"
            color="danger"
            size="xs"
            mr="xs"
            className={classes.rowAction}
          >
            <Trash2 size={12} />
          </IconAction>
        )}
        {openSectionEditor && (
          <IconAction
            label={
              section === undefined
                ? t("Files.LineSection.Start", { defaultValue: "Start section here" })
                : t("Files.LineSection.Title", { defaultValue: "Section" })
            }
            onClick={(event) => {
              event.stopPropagation();
              const bounds = event.currentTarget.getBoundingClientRect();
              openSectionEditor(bounds.left, bounds.bottom, section === undefined);
            }}
            variant="subtle"
            size="sm"
            mr="xs"
            className={classes.rowAction}
          >
            <SeparatorHorizontal size={14} />
          </IconAction>
        )}
      </Group>
    </div>
  );
}
