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
  SimpleGrid,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { atom, useAtom } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PracticeDeckValue } from "@/state/practiceStorage";
import { deckAtomFamily, type RecentFile, recentFilesAtom, tabsAtom } from "@/state/atoms";
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
  Target,
  Crosshair,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { useTranslation } from "react-i18next";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import { getStats } from "@/components/files/opening";
import Chessboard from "../icons/Chessboard";
import { FileIcon } from "@/components/files/FileIcon";

dayjs.extend(relativeTime);

const recentFileDateFormat = "YYYY-MM-DD HH:mm";

function dueCount(deck: PracticeDeckValue) {
  if (deck.status !== "ready" && deck.status !== "write-pending") return null;
  const stats = getStats(deck.positions);
  return stats.due + stats.unseen;
}

function RecentFileDuePositions({ count }: { count: number | null }) {
  const { t } = useTranslation();
  if (!count) return null;

  return (
    <Badge size="sm" variant="light" color="warning" leftSection={<Target size="0.75rem" />}>
      {count} {t("Board.Practice.Due")}
    </Badge>
  );
}

function useRecentDisplayName() {
  const { t, i18n } = useTranslation();
  return (file: RecentFile) =>
    file.name === "Unknown"
      ? `${t("Home.RecentFiles.UntitledGame")} · ${new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(file.lastOpened)}`
      : file.name.replace(/\.pgn$/i, "");
}

function RecentFileRow({
  file,
  count,
  onOpen,
}: {
  file: RecentFile;
  count: number | null;
  onOpen: (file: RecentFile) => void;
}) {
  const displayName = useRecentDisplayName()(file);

  return (
    <UnstyledButton
      onClick={() => onOpen(file)}
      px="sm"
      py={6}
      style={{
        borderRadius: "var(--mantine-radius-sm)",
      }}
      className={classes.recentFileRow}
      data-recent-file
    >
      <Group justify="space-between" wrap="nowrap">
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <Box style={{ flexShrink: 0, color: "var(--mantine-color-dimmed)" }}>
            <FileIcon type={file.type} size={20} />
          </Box>
          <Text size="sm" truncate fw={500}>
            {displayName}
          </Text>
          {file.type === "repertoire" && <RecentFileDuePositions count={count} />}
        </Group>
        <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
          <Tooltip label={dayjs(file.lastOpened).format(recentFileDateFormat)}>
            <Group gap={4} wrap="nowrap">
              <Clock size={14} style={{ color: "var(--mantine-color-dimmed)" }} />
              <Text size="xs" c="dimmed">
                {dayjs(file.lastOpened).fromNow()}
              </Text>
            </Group>
          </Tooltip>
        </Group>
      </Group>
    </UnstyledButton>
  );
}

export default function NewTabHome({ id }: { id: string }) {
  const { t } = useTranslation();

  const [openModal, setOpenModal] = useState(false);
  const [openRepertoireModal, setOpenRepertoireModal] = useState(false);
  const [, setTabs] = useAtom(tabsAtom);

  const [recentFiles, setRecentFiles] = useAtom(recentFilesAtom);
  const deckRowsAtom = useMemo(
    () =>
      atom((get) =>
        recentFiles
          .filter((file) => file.type === "repertoire")
          .map((file) => {
            const deck = get(deckAtomFamily({ file: fileWorkspaceKey(file.handle), game: 0 }));
            const failed =
              deck.status === "read-failed" ||
              deck.status === "write-blocked" ||
              (deck.status !== "loading" && deck.status !== "write-pending" && !!deck.error);
            return { file, count: failed ? null : dueCount(deck), failed };
          }),
      ),
    [recentFiles],
  );
  const [deckRows] = useAtom(deckRowsAtom);
  const dueRows = deckRows
    .filter((row) => row.failed || (row.count ?? 0) > 0)
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || b.file.lastOpened - a.file.lastOpened);
  const incomplete = deckRows.some((row) => row.count === null);
  const displayName = useRecentDisplayName();
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const checkFiles = async () => {
      const checkedRecentFiles = await Promise.all(
        recentFiles.map(async (file) => {
          try {
            await tauri.countPgnGames(file.handle, { signal: controller.signal });
            return file;
          } catch (cause) {
            return normalizeError(cause).category === "not-found" ? null : file;
          }
        }),
      );
      const filtered = checkedRecentFiles.filter((file): file is RecentFile => file !== null);
      if (!cancelled && !controller.signal.aborted && filtered.length !== recentFiles.length) {
        setRecentFiles(filtered);
      }
    };
    void checkFiles();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [recentFiles, setRecentFiles]);

  const openRecentFile = useCallback(
    async (file: RecentFile) => {
      try {
        const numGames = await tauri.countPgnGames(file.handle);
        const tabId = await openFile(
          {
            type: "file",
            name: file.name,
            handle: file.handle,
            numGames,
            metadata: { type: file.type, tags: [] },
            lastModified: Date.now(),
          },
          setTabs,
          { tabName: file.name },
        );
        if (tabId === null) return;
        navigate({ to: "/" });
      } catch (cause) {
        if (normalizeError(cause).category === "not-found") {
          setRecentFiles((current) =>
            current.filter(
              (entry) => fileWorkspaceKey(entry.handle) !== fileWorkspaceKey(file.handle),
            ),
          );
        }
        notifyUnlessCancelled(t("Common.Error"), cause);
      }
    },
    [setTabs, setRecentFiles, navigate, t],
  );

  const cards = [
    {
      icon: <ChessKnight size={60} />,
      title: t("Home.Card.PlayChess.Title"),
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
      icon: <Chessboard size={60} />,
      title: t("Home.Card.AnalysisBoard.Title"),
      description: t("Home.Card.AnalysisBoard.Desc"),
      label: t("Home.Card.AnalysisBoard.Button"),
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
      icon: <Crosshair size={60} />,
      title: t("Home.Card.NewRepertoire.Title"),
      description: t("Home.Card.NewRepertoire.Desc"),
      label: t("Home.Card.NewRepertoire.Button"),
      onClick: () => {
        setOpenRepertoireModal(true);
      },
    },
    {
      icon: <FileInputIcon size={60} />,
      title: t("Home.Card.ImportGame.Title"),
      description: t("Home.Card.ImportGame.Desc"),
      label: t("Home.Card.ImportGame.Button"),
      onClick: () => {
        setOpenModal(true);
      },
    },
    {
      icon: <Puzzle size={60} />,
      title: t("Home.Card.Puzzle.Title"),
      description: t("Home.Card.Puzzle.Desc"),
      label: t("Home.Card.Puzzle.Button"),
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
      <Stack gap="lg" pt="sm" className={classes.home}>
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 5 }} className={classes.actions}>
          {cards.map((card) => (
            <Card shadow="sm" p="lg" radius="md" withBorder key={card.title}>
              <Stack align="center" h="100%" justify="space-between">
                {card.icon}

                <Box style={{ textAlign: "center" }}>
                  <Text fw={500}>{card.title}</Text>
                  <Text size="sm" c="dimmed">
                    {card.description}
                  </Text>
                </Box>

                <Button variant="light" fullWidth mt="md" radius="md" onClick={card.onClick}>
                  {card.label}
                </Button>
              </Stack>
            </Card>
          ))}
        </SimpleGrid>

        <Box className={classes.bottom}>
          <Card p="md" radius="md" withBorder className={classes.bottomCard} data-home-recents>
            <Text fw={600} size="lg" mb="xs" data-home-title>
              {t("Home.RecentFiles.Title")}
            </Text>
            {recentFiles.length === 0 ? (
              <Stack align="center" justify="center" h={200} gap="xs">
                <Clock size={48} style={{ opacity: 0.3 }} />
                <Text c="dimmed">{t("Home.RecentFiles.NoRecentFiles")}</Text>
              </Stack>
            ) : (
              <ScrollArea className={classes.list} data-home-list>
                <Stack gap={2}>
                  {recentFiles.map((file) => (
                    <RecentFileRow
                      key={fileWorkspaceKey(file.handle)}
                      file={file}
                      count={
                        deckRows.find(
                          (row) =>
                            fileWorkspaceKey(row.file.handle) === fileWorkspaceKey(file.handle),
                        )?.count ?? null
                      }
                      onOpen={openRecentFile}
                    />
                  ))}
                </Stack>
              </ScrollArea>
            )}
          </Card>
          <Card p="md" radius="md" withBorder className={classes.bottomCard} data-home-due>
            <Text fw={600} size="lg" mb="xs">
              {t("Home.DuePractice.Title")}
            </Text>
            {dueRows.length > 0 && (
              <Text size="sm" c="dimmed" mb="xs">
                {t("Home.DuePractice.Total", {
                  positions: dueRows.reduce((total, row) => total + (row.count ?? 0), 0),
                  repertoires: dueRows.filter((row) => row.count !== null).length,
                })}
                {incomplete && <> · {t("Home.DuePractice.Incomplete")}</>}
              </Text>
            )}
            <ScrollArea className={classes.list}>
              <Stack gap="sm">
                {dueRows.map(({ file, count, failed }) => (
                  <Group
                    key={fileWorkspaceKey(file.handle)}
                    justify="space-between"
                    wrap="wrap"
                    data-due-file
                  >
                    <Box style={{ minWidth: 0, flex: 1 }}>
                      <Text size="sm" fw={500} truncate>
                        {displayName(file)}
                      </Text>
                      {failed ? (
                        <Text size="xs" c="dimmed">
                          {t("Home.DuePractice.LoadFailed")}
                        </Text>
                      ) : (
                        <Badge size="sm" variant="light" color="warning">
                          {count} {t("Board.Practice.Due")}
                        </Badge>
                      )}
                    </Box>
                    <Button size="xs" variant="light" onClick={() => void openRecentFile(file)}>
                      {t("Board.Tabs.Practice")}
                    </Button>
                  </Group>
                ))}
                {!incomplete && dueRows.length === 0 && (
                  <Text c="dimmed">{t("Home.DuePractice.NothingDue")}</Text>
                )}
                {incomplete && dueRows.length === 0 && (
                  <Text c="dimmed">{t("Common.Loading")}</Text>
                )}
              </Stack>
            </ScrollArea>
          </Card>
        </Box>
      </Stack>
    </>
  );
}
