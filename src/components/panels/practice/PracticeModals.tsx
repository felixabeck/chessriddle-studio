import { Alert, Badge, Button, Card, Divider, Group, SimpleGrid, Stack, Text } from "@mantine/core";
import AppModal from "@/components/common/AppModal";
import { ArrowRight } from "lucide-react";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDate, type ReviewLog } from "ts-fsrs";
import { normalizeError, type AppError } from "@/platform/errors";
import { formatMoveNumber } from "@/utils/format";
import { useStore } from "zustand";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { IconAction } from "@/components/common/IconAction";
import { getCardStatus, resolvePracticeCard } from "@/components/files/opening";
import {
  loadPracticeReviews,
  PRACTICE_LOG_PAGE_SIZE,
  type PracticeDeckValue,
  type PracticeDeckKey,
} from "@/state/practiceStorage";
import { getBoardState } from "@/utils/treeReducer";

export function PositionsModal({
  open,
  setOpen,
  deck,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  deck: PracticeDeckValue;
}) {
  const { t } = useTranslation();

  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const headers = useStore(store, (s) => s.headers);
  const goToMove = useStore(store, (s) => s.goToMove);
  return (
    <AppModal
      opened={open}
      onClose={() => setOpen(false)}
      size="xl"
      title={<b>{t("Board.Practice.Positions")}</b>}
    >
      {deck.positions.length === 0 && <Text>{t("Board.Practice.NoPositionsYet")}</Text>}
      <SimpleGrid cols={2}>
        {deck.positions.map((c) => {
          const resolved = resolvePracticeCard(
            root,
            getBoardState(c.fen),
            headers.orientation || "white",
            headers.start || [],
          );
          if (!resolved) return null;
          const node = resolved.frame.node;
          const status = getCardStatus(c.card);
          return (
            <Card key={c.fen}>
              <Text>{`${formatMoveNumber(node.halfMoves + 1)} ${resolved.answer}`}</Text>
              <Divider my="xs" />
              <Group justify="space-between">
                <Stack>
                  <Text tt="uppercase" fw="bold" fz="sm">
                    {t("Board.Practice.Status")}
                  </Text>
                  <Badge
                    color={status === "unseen" ? "gray" : status === "due" ? "warning" : "gold"}
                  >
                    {status === "unseen"
                      ? t("Board.Practice.Unseen")
                      : status === "due"
                        ? t("Board.Practice.Due")
                        : t("Board.Practice.Practiced")}
                  </Badge>
                </Stack>
                <Stack>
                  <Text tt="uppercase" fw="bold" fz="sm">
                    {t("Board.Practice.Due")}
                  </Text>
                  <Text>{formatDate(c.card.due)}</Text>
                </Stack>
                <IconAction
                  label={t("Board.Practice.GoBackToPosition")}
                  variant="subtle"
                  onClick={() => {
                    const state = store.getState();
                    const current = resolvePracticeCard(
                      state.root,
                      getBoardState(c.fen),
                      state.headers.orientation || "white",
                      state.headers.start || [],
                    );
                    if (!current) return;
                    goToMove(current.frame.position);
                    setOpen(false);
                  }}
                >
                  <ArrowRight />
                </IconAction>
              </Group>
            </Card>
          );
        })}
      </SimpleGrid>
    </AppModal>
  );
}

export function LogsModal({
  open,
  setOpen,
  identity,
  generation,
  epoch,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  identity: PracticeDeckKey;
  generation: number;
  epoch?: string;
}) {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const headers = useStore(store, (s) => s.headers);
  const goToMove = useStore(store, (s) => s.goToMove);
  const [logs, setLogs] = useState<Array<ReviewLog & { fen: string; id: string }>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pageError, setPageError] = useState<AppError | null>(null);
  const requestSequence = useRef(0);

  const loadPage = useCallback(
    async (cursor: string | null, replace: boolean) => {
      if (identity.file === "" || !epoch) return;
      const sequence = ++requestSequence.current;
      setLoading(true);
      setPageError(null);
      try {
        const page = await loadPracticeReviews(
          identity.file,
          identity.game,
          cursor,
          PRACTICE_LOG_PAGE_SIZE,
          epoch,
        );
        if (sequence !== requestSequence.current) return;
        const parsed = page.entries.map((entry) => ({
          ...(JSON.parse(entry.entry) as ReviewLog & { fen: string }),
          id: entry.id,
        }));
        setLogs((previous) => (replace ? parsed : [...previous, ...parsed]));
        setNextCursor(page.nextCursor);
      } catch (cause) {
        if (sequence === requestSequence.current) setPageError(normalizeError(cause));
      } finally {
        if (sequence === requestSequence.current) setLoading(false);
      }
    },
    [identity.file, identity.game, epoch],
  );

  useEffect(() => {
    if (!open) {
      requestSequence.current += 1;
      return;
    }
    setLogs([]);
    setNextCursor(null);
    setPageError(null);
    void loadPage(null, true);
    return () => {
      requestSequence.current += 1;
    };
  }, [generation, loadPage, open]);

  return (
    <AppModal
      opened={open}
      onClose={() => setOpen(false)}
      size="xl"
      title={<b>{t("Board.Practice.Logs")}</b>}
    >
      <SimpleGrid cols={2}>
        {logs.length === 0 && !loading && !pageError && (
          <Text>{t("Board.Practice.NoLogsYet")}</Text>
        )}
        {logs.map((log) => {
          const resolved = resolvePracticeCard(
            root,
            getBoardState(log.fen),
            headers.orientation || "white",
            headers.start || [],
          );
          const node = resolved?.frame.node ?? null;

          return (
            <Card key={log.id} data-practice-entry-id={log.id}>
              <Text>{node?.san ? `${formatMoveNumber(node.halfMoves)} ${node.san}` : log.fen}</Text>

              <Divider my="xs" />
              <Group justify="space-between">
                <Stack>
                  <Text tt="uppercase" fw="bold" fz="sm">
                    {t("Board.Practice.Rating")}
                  </Text>
                  <Badge
                    color={
                      log.rating === 1
                        ? "danger"
                        : log.rating === 2
                          ? "warning"
                          : log.rating === 3
                            ? "gold"
                            : "success"
                    }
                  >
                    {log.rating === 1
                      ? t("Board.Practice.Again")
                      : log.rating === 2
                        ? t("Board.Practice.Hard")
                        : log.rating === 3
                          ? t("Board.Practice.Good")
                          : t("Board.Practice.Easy")}
                  </Badge>
                </Stack>
                <Stack>
                  <Text tt="uppercase" fw="bold" fz="sm">
                    {t("Common.Date")}
                  </Text>
                  <Text>{formatDate(log.review)}</Text>
                </Stack>
                {resolved && (
                  <IconAction
                    label={t("Board.Practice.GoBackToPosition")}
                    variant="subtle"
                    onClick={() => {
                      const state = store.getState();
                      const current = resolvePracticeCard(
                        state.root,
                        getBoardState(log.fen),
                        state.headers.orientation || "white",
                        state.headers.start || [],
                      );
                      if (!current) return;
                      goToMove(current.frame.position);
                      setOpen(false);
                    }}
                  >
                    <ArrowRight />
                  </IconAction>
                )}
              </Group>
            </Card>
          );
        })}
      </SimpleGrid>
      {pageError && (
        <Alert color="danger" mt="sm">
          {t("Board.Practice.LogsLoadFailed", { cause: pageError.message })}
        </Alert>
      )}
      {nextCursor && (
        <Button
          mt="sm"
          variant="light"
          loading={loading}
          onClick={() => void loadPage(nextCursor, false)}
        >
          {t("Board.Practice.LoadMore")}
        </Button>
      )}
    </AppModal>
  );
}
