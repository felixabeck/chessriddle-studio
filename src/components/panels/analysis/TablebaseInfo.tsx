import { Accordion, Badge, Group, Paper, SimpleGrid, Stack, Text } from "@mantine/core";
import { parseUci } from "chessops";
import { useContext } from "react";
import { useTranslation } from "react-i18next";
import useSWRImmutable from "swr/immutable";
import { match, P } from "ts-pattern";
import { useStore } from "zustand";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { inlineFailureMessage } from "@/components/files/notifyError";
import { getTablebaseInfo, type TablebaseCategory } from "@/utils/lichess/api";
import classes from "./TablebaseInfo.module.css";

function TablebaseInfo({ fen, turn }: { fen: string; turn: "white" | "black" }) {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const makeMove = useStore(store, (s) => s.makeMove);
  const { data, error, isLoading } = useSWRImmutable(
    ["tablebase", fen],
    async ([_, fen]) => await getTablebaseInfo(fen),
    // A schema rejection is deterministic, so retries are bounded while a transient network failure can still recover.
    { errorRetryCount: 3 },
  );

  // SWR owns `data`; sorting it in place changes the cache seen by every view.
  const sortedMoves = data ? [...data.moves].sort(compareTablebaseMoves) : undefined;
  const errorText = inlineFailureMessage(error, undefined, t("Common.Error"));

  return (
    <Paper withBorder>
      <Accordion
        styles={{
          label: {
            padding: 8,
          },
        }}
      >
        <Accordion.Item value="tablebase">
          <Accordion.Control>
            <Group>
              <Text fw="bold">{t("Board.Analysis.Tablebase")}</Text>
              {isLoading && (
                <Group p="xs">
                  <Badge variant="transparent">{t("Common.Loading")}</Badge>
                </Group>
              )}
              {errorText !== undefined && <Text>{errorText}</Text>}
              {data && <OutcomeBadge category={data.category} turn={turn} wins />}
            </Group>
          </Accordion.Control>
          <Accordion.Panel>
            {data && (
              <Stack gap="xs">
                <SimpleGrid className={classes.grid}>
                  {sortedMoves!.map((m) => (
                    <Paper
                      withBorder
                      key={m.san}
                      px="xs"
                      onClick={() => {
                        const move = parseUci(m.uci);
                        if (move) makeMove({ payload: move });
                      }}
                      className={classes.info}
                    >
                      <Group gap="xs" justify="space-between" className={classes.moveContent}>
                        <Text fz="0.9rem" fw={600} ta="center" className={classes.san}>
                          {m.san}
                        </Text>
                        <OutcomeBadge
                          category={m.category}
                          dtz={m.dtz === null ? undefined : Math.abs(m.dtz)}
                          dtm={m.dtm ?? undefined}
                          turn={turn === "white" ? "black" : "white"}
                        />
                      </Group>
                    </Paper>
                  ))}
                </SimpleGrid>
              </Stack>
            )}
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Paper>
  );
}

// Child categories describe the opponent's position, so their losses are our best moves.
const tablebaseRank: Record<TablebaseCategory, number> = {
  loss: 0,
  "blessed-loss": 1,
  draw: 2,
  "cursed-win": 3,
  win: 4,
  "maybe-win": 5,
  "maybe-loss": 6,
  unknown: 7,
};

export function compareTablebaseMoves(
  a: { category: TablebaseCategory; san: string },
  b: { category: TablebaseCategory; san: string },
) {
  return tablebaseRank[a.category] - tablebaseRank[b.category] || a.san.localeCompare(b.san);
}

function OutcomeBadge({
  category,
  turn,
  wins,
  dtz,
  dtm,
}: {
  category: TablebaseCategory;
  turn: "white" | "black";
  wins?: boolean;
  dtz?: number;
  dtm?: number;
}) {
  const { t } = useTranslation();
  const normalizedCategory = match(category)
    .with("win", () =>
      turn === "white"
        ? t("Board.Analysis.Tablebase.WhiteWins")
        : t("Board.Analysis.Tablebase.BlackWins"),
    )
    .with("loss", () =>
      turn === "white"
        ? t("Board.Analysis.Tablebase.BlackWins")
        : t("Board.Analysis.Tablebase.WhiteWins"),
    )
    .with(P.union("draw", "blessed-loss", "cursed-win"), () => t("Board.Analysis.Tablebase.Draw"))
    .with(P.union("unknown", "maybe-win", "maybe-loss"), () => t("Common.Unknown"))
    .exhaustive();

  const color = match(category)
    .with("win", () => (turn === "white" ? "var(--cf-eval-bar-light)" : "var(--cf-eval-bar-dark)"))
    .with("loss", () => (turn === "white" ? "var(--cf-eval-bar-dark)" : "var(--cf-eval-bar-light)"))
    .otherwise(() => "var(--cf-muted-foreground)");

  const label = wins
    ? normalizedCategory
    : match(category)
        .with("draw", () => t("Board.Analysis.Tablebase.Draw"))
        .with("unknown", () => t("Common.Unknown"))
        .otherwise(() => {
          if (dtm) return `DTM ${Math.abs(dtm)}`;
          if (typeof dtz === "number") return `DTZ ${dtz}`;
          return t("Common.Unknown");
        });

  return (
    <Group p="xs">
      <Badge
        variant="filled"
        color={color}
        styles={{
          root: {
            color:
              color === "var(--cf-eval-bar-dark)"
                ? "var(--cf-eval-bar-light)"
                : "var(--cf-eval-bar-dark)",
          },
        }}
      >
        {label}
      </Badge>
      {["blessed-loss", "cursed-win", "maybe-win", "maybe-loss"].includes(category) && wins && (
        <Text c="dimmed" fz="xs">
          {t("Board.Analysis.Tablebase.FiftyMoveRule")}
        </Text>
      )}
    </Group>
  );
}

export default TablebaseInfo;
