import { tauri } from "@/platform/tauri";
import { normalizeError } from "@/platform/errors";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import {
  Badge,
  Box,
  Button,
  Card,
  Group,
  ScrollArea,
  SegmentedControl,
  TextInput,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
  useMatches,
} from "@mantine/core";
import { useAtom, useSetAtom, useStore } from "jotai";
import equal from "fast-deep-equal";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  addRecentFileAtom,
  updateRecentFilesAtom,
  isDatabaseRecent,
  recentFileKey,
  lastOpenedAtom,
  type RecentFile,
  recentFilesAtom,
  tabsAtom,
} from "@/state/atoms";
import { gameSignature, openDatabaseGame } from "@/utils/databaseGame";
import type { Tab } from "@/utils/tabs";
import { openFile } from "@/utils/files";
import CreateRepertoireModal from "./CreateRepertoireModal";
import ImportModal from "./ImportModal";
import classes from "./NewTabHome.module.css";
import {
  ChessKnight,
  Clock,
  FileInput as FileInputIcon,
  Puzzle,
  Crosshair,
  Search,
  ScanSearch,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { useTranslation } from "react-i18next";

import { FileIcon } from "@/components/files/FileIcon";

import { useLibraryData } from "@/components/library/useLibraryData";
import { useLibraryDueCounts } from "@/components/library/useLibraryDueCounts";
import { useOwnGamesFeed } from "@/components/library/useOwnGamesFeed";
import { openStandaloneDatabase } from "@/components/library/openStandaloneDatabase";
import { compareLibraryRows, type LibraryRow } from "@/components/library/libraryData";
import type { OwnGame } from "@/components/library/ownGamesFeed";
import type { FileMetadata, FileType } from "@/components/files/file";
import { databaseGameOpenedKey } from "@/state/lastOpened";
import { query_games } from "@/utils/db";

dayjs.extend(relativeTime);

type HomeRow =
  | LibraryRow
  | {
      kind: "game";
      key: string;
      name: string;
      modified: number;
      opened?: number;
      recent?: Extract<RecentFile, { kind: "database" }>;
      own?: OwnGame;
    };

function rowFileType(row: HomeRow): FileType {
  return row.kind === "file"
    ? "metadata" in row.file
      ? row.file.metadata.type
      : row.file.type
    : "game";
}

const recentFileDateFormat = "YYYY-MM-DD HH:mm";

function RecentFileDuePositions({ count }: { count: number | null }) {
  const { t } = useTranslation();
  if (!count) return null;

  return (
    <Badge className={classes.dueBadge} size="sm" variant="light" color="warning">
      {count} {t("Board.Practice.Due")}
    </Badge>
  );
}

function LibraryItemRow({
  row,
  count,
  secondary,
  disabled,
  onOpen,
}: {
  row: HomeRow;
  count: number | null;
  secondary?: string;
  disabled: boolean;
  onOpen: (row: HomeRow) => void;
}) {
  const { t, i18n } = useTranslation();
  const time = row.opened ?? row.modified;
  const own = row.kind === "game" ? row.own : undefined;
  const gameDate = own?.game.date;
  const name =
    row.name === "Unknown"
      ? `${t("Home.RecentFiles.UntitledGame")} · ${new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(time)}`
      : row.name.replace(/\.pgn$/i, "");
  return (
    <UnstyledButton
      className={classes.libraryRow}
      disabled={disabled}
      onClick={() => onOpen(row)}
      data-library-row
      data-kind={row.kind}
    >
      <FileIcon type={rowFileType(row)} size={20} className={classes.icon} />
      <Box className={classes.rowContent}>
        <Group gap={4} wrap="nowrap">
          <Text className={classes.rowName} size="sm" fw={500}>
            {name}
          </Text>
          <RecentFileDuePositions count={count} />
        </Group>
        {secondary && (
          <Text size="xs" c="dimmed" className={classes.secondary}>
            {secondary}
          </Text>
        )}
      </Box>
      {own ? (
        gameDate && gameDate !== "????.??.??" ? (
          <Text size="xs" c="dimmed" className={classes.time}>
            {gameDate}
          </Text>
        ) : null
      ) : (
        time > 0 && (
          <Tooltip label={dayjs(time).format(recentFileDateFormat)}>
            <Group gap={4} wrap="nowrap" className={classes.time}>
              <Clock size={14} />
              <Text size="xs" c="dimmed">
                {dayjs(time).fromNow()}
              </Text>
            </Group>
          </Tooltip>
        )
      )}
    </UnstyledButton>
  );
}

export default function NewTabHome({ id }: { id: string }) {
  const store = useStore();
  const { t } = useTranslation();

  const [openModal, setOpenModal] = useState(false);
  const [openRepertoireModal, setOpenRepertoireModal] = useState(false);
  const [, setTabs] = useAtom(tabsAtom);

  const [recentFiles, setRecentFiles] = useAtom(recentFilesAtom);
  const addRecentFile = useSetAtom(addRecentFileAtom);
  const updateRecentFiles = useSetAtom(updateRecentFilesAtom);
  const navigate = useNavigate();
  const [lastOpened] = useAtom(lastOpenedAtom);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const filterOrientation = useMatches({ base: "vertical", sm: "horizontal" } as const, {
    getInitialValueInEffect: false,
  });
  const search = query.trim();
  const library = useLibraryData();
  const due = useLibraryDueCounts(library.rows);
  const feed = useOwnGamesFeed(
    library.collections,
    search,
    filter === "games" || (filter === "all" && !!search),
  );
  const opening = useRef<AbortController | null>(null);
  useEffect(() => () => opening.current?.abort(), []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const checkFiles = async () => {
      const checkedRecentFiles = await Promise.all(
        recentFiles.map(async (file) => {
          try {
            if (isDatabaseRecent(file)) {
              const result = await tauri.getDbGame(
                file.database,
                file.gameId,
                file.linked ?? null,
                { signal: controller.signal },
              );
              if (result.kind === "missing") return null;
              const linked = result.game.linked
                ? { locator: result.game.linked, signature: gameSignature(result.game) }
                : undefined;
              if (result.game.id !== file.gameId || !equal(linked, file.linked)) {
                return { ...file, gameId: result.game.id, linked };
              }
              return file;
            }
            await tauri.countPgnGames(file.handle, { signal: controller.signal });
            return file;
          } catch (cause) {
            return !isDatabaseRecent(file) && normalizeError(cause).category === "not-found"
              ? null
              : file;
          }
        }),
      );
      if (
        !cancelled &&
        !controller.signal.aborted &&
        checkedRecentFiles.some((file, i) => file !== recentFiles[i])
      ) {
        updateRecentFiles((current) =>
          current.flatMap((file) => {
            const index = recentFiles.indexOf(file);
            const checked = index < 0 ? file : checkedRecentFiles[index];
            return checked ? [checked] : [];
          }),
        );
      }
    };
    void checkFiles();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [recentFiles, updateRecentFiles]);

  const openRecentFile = useCallback(
    async (file: RecentFile, panel?: "practice", source?: FileMetadata) => {
      try {
        if (isDatabaseRecent(file)) {
          const result = await tauri.getDbGame(file.database, file.gameId, file.linked ?? null);
          if (result.kind === "missing") {
            setRecentFiles((current) =>
              current.filter((entry) => recentFileKey(entry) !== recentFileKey(file)),
            );
            notifyUnlessCancelled(t("Common.Error"), {
              category: "not-found",
              message: t("GameReferences.Missing"),
            });
            return;
          }
          const tabId = await openDatabaseGame({
            game: result.game,
            database: file.database,
            databaseTitle: file.databaseTitle,
            setTabs,
            addRecentFile,
            ownerId: id,
            store,
          });
          if (tabId !== null) navigate({ to: "/" });
          return;
        }
        const numGames = await tauri.countPgnGames(file.handle);
        const tabId = await openFile(
          {
            type: "file",
            name: file.name,
            handle: file.handle,
            numGames,
            metadata: source?.metadata ?? { type: file.type, tags: [] },
            lastModified: source?.lastModified ?? Date.now(),
          },
          setTabs,
          {
            ...(!source ? { tabName: file.name } : {}),
            ownerId: id,
            store,
            ...(panel ? { panel } : {}),
          },
        );
        if (tabId === null) return;
        navigate({ to: "/" });
      } catch (cause) {
        if (!isDatabaseRecent(file) && normalizeError(cause).category === "not-found") {
          setRecentFiles((current) =>
            current.filter((entry) => recentFileKey(entry) !== recentFileKey(file)),
          );
        }
        notifyUnlessCancelled(t("Common.Error"), cause);
      }
    },
    [setTabs, setRecentFiles, addRecentFile, navigate, t, id, store],
  );

  const openRow = async (row: HomeRow) => {
    if (row.kind === "file") {
      const file = row.file;
      await openRecentFile(
        "metadata" in file
          ? {
              name: file.name,
              handle: file.handle,
              type: file.metadata.type,
              lastOpened: row.opened ?? row.modified,
            }
          : file,
        filter === "due" ? "practice" : undefined,
        "metadata" in file ? file : undefined,
      );
      return;
    }
    if (row.kind === "game" && row.recent) {
      await openRecentFile(row.recent);
      return;
    }
    opening.current?.abort();
    const controller = new AbortController();
    opening.current = controller;
    try {
      if (row.kind === "database") {
        if (row.database.type !== "success") throw new Error(t("Home.Library.OpenFailed"));
        openStandaloneDatabase(row.database, navigate);
      } else if (row.kind === "collection" && row.collection.database) {
        const database = row.collection.database;
        const metadata = await tauri.getDbInfo(database);
        if (controller.signal.aborted) return;
        if (metadata.status !== "ready") throw new Error(t("Home.Library.OpenFailed"));
        if (metadata.game_count === 1) {
          const result = await query_games(
            database,
            {
              options: { sort: "newest", direction: "desc", page: 1, pageSize: 1, skipCount: true },
            },
            { signal: controller.signal },
          );
          if (controller.signal.aborted) return;
          const game = result.data[0];
          if (!game) throw new Error(t("Home.Library.OpenFailed"));
          const tabId = await openDatabaseGame({
            game,
            database,
            databaseTitle: row.name,
            setTabs,
            addRecentFile,
            ownerId: id,
            store,
          });
          if (tabId !== null) navigate({ to: "/" });
        } else
          openStandaloneDatabase(
            { ...metadata, type: "success", file: database, collection: row.collection },
            navigate,
          );
      } else if (row.kind === "game" && row.own) {
        const tabId = await openDatabaseGame({
          game: row.own.game,
          database: row.own.collection.database,
          databaseTitle: row.own.collection.name,
          setTabs,
          addRecentFile,
          ownerId: id,
          store,
        });
        if (tabId !== null) navigate({ to: "/" });
      }
    } catch (cause) {
      if (!controller.signal.aborted) notifyUnlessCancelled(t("Home.Library.OpenFailed"), cause);
    } finally {
      if (opening.current === controller) opening.current = null;
    }
  };

  const matches = (row: HomeRow) =>
    row.name.toLocaleLowerCase().includes(search.toLocaleLowerCase());
  const recentGames: HomeRow[] = recentFiles
    .filter(isDatabaseRecent)
    .map((recent) => ({
      kind: "game" as const,
      key: databaseGameOpenedKey(recent.database, recent.gameId),
      name: recent.name,
      modified: 0,
      opened: Math.max(
        recent.lastOpened,
        lastOpened[databaseGameOpenedKey(recent.database, recent.gameId)] ?? 0,
      ),
      recent,
    }))
    .sort(compareLibraryRows)
    .slice(0, 10);
  const ownGames: HomeRow[] = feed.games.map((own) => ({
    kind: "game",
    key: databaseGameOpenedKey(own.collection.database!, own.game.id),
    name: `${own.game.white} - ${own.game.black}`,
    modified: 0,
    own,
    opened: lastOpened[databaseGameOpenedKey(own.collection.database!, own.game.id)],
  }));
  let rows: HomeRow[];
  if (filter === "due") {
    rows = [...due.dueRows]
      .sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || compareLibraryRows(a.file, b.file))
      .map((row) => row.file)
      .filter(matches);
  } else if (filter === "repertoires") {
    rows = library.rows.filter((row) => rowFileType(row) === "repertoire" && matches(row));
  } else if (filter === "games") {
    rows = [
      ...library.rows.filter((row) => row.kind === "database" && matches(row)),
      ...library.rows.filter(
        (row) => row.kind === "file" && rowFileType(row) === "game" && matches(row),
      ),
      ...ownGames,
    ];
  } else {
    rows = search
      ? library.rows.filter(matches)
      : [...library.rows, ...recentGames].sort(compareLibraryRows);
    if (search) {
      const seen = new Set(rows.map((row) => row.key));
      for (const row of [...recentGames.filter(matches), ...ownGames]) {
        if (!seen.has(row.key)) {
          rows.push(row);
          seen.add(row.key);
        }
      }
    }
  }
  const incomplete = library.loading || due.incomplete;
  const cards = [
    {
      icon: <ChessKnight size={18} />,
      description: t("Home.Card.PlayChess.Desc"),
      label: t("Home.Card.PlayChess.Button"),
      onClick: () => {
        setTabs((prev: Tab[]) =>
          prev.map((tab) =>
            tab.value === id ? { ...tab, name: t("Home.NewGame"), type: "play" } : tab,
          ),
        );
      },
    },
    {
      icon: <ScanSearch size={18} />,
      description: t("Home.Card.AnalysisBoard.Desc"),
      label: t("Home.Card.AnalysisBoard.Title"),
      onClick: () => {
        setTabs((prev: Tab[]) =>
          prev.map((tab) =>
            tab.value === id
              ? { ...tab, name: t("Home.Card.AnalysisBoard.Title"), type: "analysis" }
              : tab,
          ),
        );
      },
    },
    {
      icon: <Crosshair size={18} />,
      description: t("Home.Card.NewRepertoire.Desc"),
      label: t("Home.Card.NewRepertoire.Title"),
      onClick: () => {
        setOpenRepertoireModal(true);
      },
    },
    {
      icon: <FileInputIcon size={18} />,
      description: t("Home.Card.ImportGame.Desc"),
      label: t("Home.Card.ImportGame.Button"),
      onClick: () => {
        setOpenModal(true);
      },
    },
    {
      icon: <Puzzle size={18} />,
      description: t("Home.Card.Puzzle.Desc"),
      label: t("Home.Card.Puzzle.Title"),
      onClick: () => {
        setTabs((prev) =>
          prev.map((tab) =>
            tab.value === id ? { ...tab, name: t("Home.PuzzleTraining"), type: "puzzles" } : tab,
          ),
        );
      },
    },
  ];

  return (
    <>
      <ImportModal
        ownerId={id}
        openModal={openModal}
        setOpenModal={setOpenModal}
        setTabs={setTabs}
      />
      <CreateRepertoireModal opened={openRepertoireModal} setOpened={setOpenRepertoireModal} />
      <Stack gap="md" className={classes.home}>
        <Group gap="md" className={classes.actions} data-home-actions>
          {[
            [cards[0], cards[1], cards[4]],
            [cards[2], cards[3]],
          ].map((group, index) => (
            <Group gap="md" key={index}>
              {group.map((action) => (
                <Tooltip label={action.description} key={action.label}>
                  <Button
                    variant="default"
                    leftSection={action.icon}
                    onClick={action.onClick}
                    className={classes.action}
                    data-home-action
                  >
                    {action.label}
                  </Button>
                </Tooltip>
              ))}
            </Group>
          ))}
        </Group>
        <Card withBorder className={classes.library} data-home-library>
          <Stack gap="md" mih={0} flex={1}>
            <Text fw={600} size="lg" data-home-title>
              {t("Library.Title")}
            </Text>
            <TextInput
              aria-label={t("Home.Library.Search")}
              placeholder={t("Home.Library.Search")}
              leftSection={<Search size={16} />}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
            <SegmentedControl
              orientation={filterOrientation}
              className={classes.filters}
              value={filter}
              onChange={setFilter}
              data={[
                { value: "all", label: t("Home.Library.All") },
                { value: "repertoires", label: t("Home.Library.Repertoires") },
                { value: "games", label: t("Home.Library.Games") },
                { value: "due", label: t("Home.Library.Due") },
              ]}
            />
            {!library.workspace && (
              <Text size="sm" c="dimmed">
                {t("Home.Library.NoWorkspace")}
              </Text>
            )}
            {(library.listingError ||
              library.databaseError ||
              library.unread.length > 0 ||
              library.failedFiles.length > 0 ||
              library.unreadDatabases.length > 0) && (
              <Text size="sm" role="status">
                {t("Home.Library.LoadFailed")}
              </Text>
            )}
            {feed.incompleteCount > 0 && (
              <Text size="sm" role="status">
                {t("Home.Library.GamesIncomplete", { collections: feed.incompleteCount })}
              </Text>
            )}
            {filter === "games" && library.collections === undefined && !library.loading && (
              <Text size="sm" c="dimmed">
                {t("Home.Library.GameFiles")}
              </Text>
            )}
            {filter === "due" && due.dueRows.length > 0 && (
              <Text size="sm" c="dimmed">
                {t("Home.DuePractice.Total", {
                  positions: due.total,
                  repertoires: due.dueRows.filter((row) => row.count !== null).length,
                })}
                {incomplete && <> · {t("Home.DuePractice.Incomplete")}</>}
              </Text>
            )}
            <ScrollArea className={classes.list} data-home-list>
              <Stack gap={0}>
                {rows.map((row) => {
                  const practice = due.rows.find((entry) => entry.file.key === row.key);
                  const disabled =
                    row.kind === "collection" &&
                    (!row.collection.database || row.collection.status !== "ready");
                  const secondary = disabled
                    ? t("Home.Library.CollectionUnavailable")
                    : practice?.failed
                      ? t("Home.DuePractice.LoadFailed")
                      : row.kind === "game"
                        ? (row.recent?.databaseTitle ?? row.own?.collection.name)
                        : row.kind === "database"
                          ? t("Library.GamesDatabase")
                          : undefined;
                  return (
                    <LibraryItemRow
                      key={row.key}
                      row={row}
                      count={practice?.count ?? null}
                      secondary={secondary}
                      disabled={disabled}
                      onOpen={(item) => void openRow(item)}
                    />
                  );
                })}
                {(library.loading ||
                  feed.loading ||
                  (filter === "due" && due.incomplete && rows.length === 0)) && (
                  <Text size="sm" c="dimmed" role="status">
                    {t("Common.Loading")}
                  </Text>
                )}
                {rows.length === 0 && !library.loading && !feed.loading && (
                  <Text c="dimmed">
                    {filter === "due" && !incomplete
                      ? t("Home.DuePractice.NothingDue")
                      : t("Home.Library.Empty")}
                  </Text>
                )}
                {feed.active && feed.hasMore && (
                  <Button
                    variant="subtle"
                    loading={feed.loading}
                    onClick={() => void feed.showMore()}
                  >
                    {t("Home.Library.ShowMore")}
                  </Button>
                )}
              </Stack>
            </ScrollArea>
            <Button
              variant="subtle"
              className={classes.libraryLink}
              onClick={() => void navigate({ to: "/library" })}
            >
              {t("Home.Library.OpenLibrary")}
            </Button>
          </Stack>
        </Card>
      </Stack>
    </>
  );
}
