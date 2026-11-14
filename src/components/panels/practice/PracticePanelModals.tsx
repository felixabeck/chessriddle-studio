import {
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from "@mantine/core";
import AppModal from "../../common/AppModal";
import { ArrowRight, Check } from "lucide-react";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDate, type ReviewLog } from "ts-fsrs";
import { normalizeError, type AppError } from "@/platform/errors";
import { formatDecimal, formatMoveNumber, formatReviewInterval } from "@/utils/format";
import { useStore } from "zustand";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { IconAction } from "@/components/common/IconAction";
import { getCardStatus, getNextReviewTimes, resolvePracticeCard } from "@/components/files/opening";
import {
  loadPracticeReviews,
  PRACTICE_LOG_PAGE_SIZE,
  type PracticeDeckValue,
  type PracticeDeckKey,
} from "@/state/practiceStorage";
import { findFen, getBoardState, getNodeAtPath } from "@/utils/treeReducer";

export function QualityRatingPanel({
  onRate,
  card,
  timeTaken,
}: {
  onRate: (grade: 1 | 2 | 3 | 4) => void;
  card?: import("ts-fsrs").Card;
  timeTaken?: number;
}) {
  const { t, i18n } = useTranslation();
  const reviewTimes = card ? getNextReviewTimes(card) : null;
  const now = Date.now();

  return (
    <Paper p="sm" withBorder>
      <Stack gap="sm" align="center">
        <Group gap="xs">
          <ThemeIcon size="md" color="success" variant="light" radius="xl">
            <Check size={16} />
          </ThemeIcon>
          <Text fw={500} c="success">
            {t("Board.Practice.Correct")}
          </Text>
          {timeTaken !== undefined && (
            <Text fz="xs" c="dimmed">
              ({t("Common.SecondsShort", { value: formatDecimal(timeTaken / 1000, i18n.language) })}
              )
            </Text>
          )}
        </Group>
        <Text fz="sm" c="dimmed">
          {t("Board.Practice.HowDifficult")}
        </Text>
        <SimpleGrid cols={4} spacing="xs" style={{ width: "100%" }}>
          <Tooltip label={t("Board.Practice.AgainHint")}>
            <Button
              color="danger"
              variant="light"
              size="compact-md"
              onClick={() => onRate(1)}
              style={{ height: "auto", padding: "4px 0" }}
            >
              <Stack gap={0} align="center">
                <Text fz="xs" fw={600}>
                  {t("Board.Practice.Again")}
                </Text>
                <Text fz={10} c="dimmed">
                  {reviewTimes
                    ? formatReviewInterval(reviewTimes[1].getTime(), now, i18n.language)
                    : ""}
                </Text>
              </Stack>
            </Button>
          </Tooltip>
          <Tooltip label={t("Board.Practice.HardHint")}>
            <Button
              color="warning"
              variant="light"
              size="compact-md"
              onClick={() => onRate(2)}
              style={{ height: "auto", padding: "4px 0" }}
            >
              <Stack gap={0} align="center">
                <Text fz="xs" fw={600}>
                  {t("Board.Practice.Hard")}
                </Text>
                <Text fz={10} c="dimmed">
                  {reviewTimes
                    ? formatReviewInterval(reviewTimes[2].getTime(), now, i18n.language)
                    : ""}
                </Text>
              </Stack>
            </Button>
          </Tooltip>
          <Tooltip label={t("Board.Practice.GoodHint")}>
            <Button
              color="gold"
              variant="light"
              size="compact-md"
              onClick={() => onRate(3)}
              style={{ height: "auto", padding: "4px 0" }}
            >
              <Stack gap={0} align="center">
                <Text fz="xs" fw={600}>
                  {t("Board.Practice.Good")}
                </Text>
                <Text fz={10} c="dimmed">
                  {reviewTimes
                    ? formatReviewInterval(reviewTimes[3].getTime(), now, i18n.language)
                    : ""}
                </Text>
              </Stack>
            </Button>
          </Tooltip>
          <Tooltip label={t("Board.Practice.EasyHint")}>
            <Button
              color="success"
              variant="light"
              size="compact-md"
              onClick={() => onRate(4)}
              style={{ height: "auto", padding: "4px 0" }}
            >
              <Stack gap={0} align="center">
                <Text fz="xs" fw={600}>
                  {t("Board.Practice.Easy")}
                </Text>
                <Text fz={10} c="dimmed">
                  {reviewTimes
                    ? formatReviewInterval(reviewTimes[4].getTime(), now, i18n.language)
                    : ""}
                </Text>
              </Stack>
            </Button>
          </Tooltip>
        </SimpleGrid>
        <Text fz={10} c="dimmed">
          {t("Board.Practice.KeyboardHint")}
        </Text>
      </Stack>
    </Paper>
  );
}

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
          const position = findFen(log.fen, root);
          const node = position ? getNodeAtPath(root, position) : null;

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
                {position && (
                  <IconAction
                    label={t("Board.Practice.GoBackToPosition")}
                    variant="subtle"
                    onClick={() => {
                      goToMove(position);
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
