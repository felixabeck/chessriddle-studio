import { tauri } from "@/platform/tauri";
import {
  Box,
  Divider,
  Group,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Color } from "chessops";
import { useAtom, useAtomValue } from "jotai";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DatabaseHandle, PlayerGameInfo } from "@/bindings";
import { useGameOpen } from "@/components/common/gameOpen";
import {
  AccountOpeningTree,
  type OpeningTreeSource,
} from "@/components/databases/PlayerOpeningTree";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { fontSizeAtom, tabsAtom } from "@/state/atoms";
import { parsePGN } from "@/utils/chess";
import type { AccountSite } from "@/utils/session";
import { createTab, runTabCreation } from "@/utils/tabs";
import { countMainPly, defaultTree } from "@/utils/treeReducer";
import classes from "./OpeningsPanel.module.css";
import {
  ALL_ACCOUNTS,
  ALL_WEBSITES,
  aggregateOpenings,
  filterPlayerStats,
  formatScorePercent,
  matchingTimeControls,
  type OpeningSort,
  type OpeningStats,
  sortOpenings,
  WEBSITE_SITE,
} from "./overviewStatistics";
import ResultsChart from "./ResultsChart";
import filterClasses from "./StatisticsFilters.module.css";
import TimeControlSelector from "./TimeControlSelector";
import WebsiteAccountSelector from "./WebsiteAccountSelector";

/** One account database of the player, with the statistics its filters are derived from. */
export type AccountOpeningSource = {
  key: string;
  label: string;
  file: DatabaseHandle;
  player: number;
  provider: AccountSite;
  username: string;
  info: PlayerGameInfo;
};

/** The sources the Website, Account and Time control filters leave for the opening tree. */
function filterOpeningSources(
  sources: AccountOpeningSource[],
  filters: { website: string | null; account: string | null; timeControl: string | null },
): OpeningTreeSource[] {
  return sources
    .filter(
      (source) =>
        filters.website === ALL_WEBSITES ||
        (filters.website !== null && WEBSITE_SITE[filters.website] === source.provider),
    )
    .filter((source) => filters.account === ALL_ACCOUNTS || source.username === filters.account)
    .flatMap(({ key, label, file, player, info }) => {
      if (!filters.timeControl || filters.timeControl === "any") {
        return [{ key, label, file, player }];
      }
      const timeControls = matchingTimeControls(info, filters.timeControl);
      // A database without a game in the category has nothing to search.
      return timeControls.length > 0 ? [{ key, label, file, player, timeControls }] : [];
    });
}

function OpeningsPanel({
  playerKey,
  name = "",
  info,
  isDatabase,
  sources,
}: {
  playerKey: string;
  name?: string;
  info: PlayerGameInfo;
  isDatabase?: boolean;
  /** The player's account databases; given, the panel offers the board view beside the list. */
  sources?: AccountOpeningSource[];
}) {
  const { t } = useTranslation();
  const [website, setWebsite] = useState<string | null>(ALL_WEBSITES);
  const [account, setAccount] = useState<string | null>(ALL_ACCOUNTS);
  const [timeControl, setTimeControl] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "board">("list");
  const [sort, setSort] = useState<OpeningSort>("games");
  const board = sources !== undefined && view === "board";

  const openingData = filterPlayerStats(info, { website, account, timeControl }).flatMap(
    (site) => site.openings,
  );

  const whiteOpenings = sortOpenings(aggregateOpenings(openingData, "white"), sort);
  const blackOpenings = sortOpenings(aggregateOpenings(openingData, "black"), sort);
  const whiteGames = whiteOpenings.reduce((total, opening) => total + opening.games, 0);
  const blackGames = blackOpenings.reduce((total, opening) => total + opening.games, 0);

  const fontSize = useAtomValue(fontSizeAtom);
  const [, setTabs] = useAtom(tabsAtom);
  const navigate = useNavigate();
  const reportOpenError = (error: unknown) => notifyUnlessCancelled(t("Common.Error"), error);
  const gameOpen = useGameOpen(
    ({ name, color }: { name: string; color: Color }) =>
      runTabCreation({
        create: async () => {
          const pgn = await tauri.getOpeningFromName(name);
          const headers = defaultTree().headers;
          const tree = await parsePGN(pgn);
          headers.orientation = color;
          return createTab({
            tab: { name, type: "analysis" },
            pgn,
            headers,
            setTabs,
            position: Array(countMainPly(tree.root)).fill(0),
          });
        },
        onSuccess: () => navigate({ to: "/" }),
        onError: reportOpenError,
      }),
    reportOpenError,
  );

  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: Math.max(whiteOpenings.length, blackOpenings.length),
    // Rows are measured: a name or its figures can wrap to a second line.
    estimateSize: () => 140 * (fontSize / 100),
    getScrollElement: () => parentRef.current,
  });

  return (
    <Stack gap={0} h="100%" className={classes.panel}>
      <div className={filterClasses.filters}>
        {!isDatabase && (
          <WebsiteAccountSelector
            playerKey={playerKey}
            onWebsiteChange={(website) => {
              setWebsite(website);
            }}
            onAccountChange={setAccount}
            allowAll={true}
          />
        )}
        <TimeControlSelector
          website={website}
          onTimeControlChange={setTimeControl}
          allowAll={true}
        />
        {!board && (
          <Select
            classNames={{ dropdown: filterClasses.dropdown }}
            pt="lg"
            label={t("Home.Personal.Openings.Sort", { defaultValue: "Sort by" })}
            value={sort}
            onChange={(value) => value && setSort(value as OpeningSort)}
            data={[
              {
                value: "games",
                label: t("Home.Personal.Openings.SortGames", { defaultValue: "Most played" }),
              },
              {
                value: "best",
                label: t("Home.Personal.Openings.SortBest", { defaultValue: "Best score" }),
              },
              {
                value: "worst",
                label: t("Home.Personal.Openings.SortWorst", { defaultValue: "Worst score" }),
              },
            ]}
            allowDeselect={false}
          />
        )}
      </div>

      {sources !== undefined && (
        <SegmentedControl
          mt="md"
          style={{ flexShrink: 0, alignSelf: "flex-start" }}
          aria-label={t("Home.Personal.Openings.View", { defaultValue: "View" })}
          value={view}
          onChange={(value) => setView(value as "list" | "board")}
          data={[
            {
              value: "list",
              label: t("Home.Personal.Openings.List", { defaultValue: "List" }),
            },
            {
              value: "board",
              label: t("Home.Personal.Openings.Board", { defaultValue: "Board" }),
            },
          ]}
        />
      )}

      {board ? (
        <div className={classes.board} data-openings-board>
          <AccountOpeningTree
            key={playerKey}
            name={name}
            sources={filterOpeningSources(sources, { website, account, timeControl })}
          />
        </div>
      ) : (
        <>
          <Group grow pt="xl">
            <Text ta="center" fw="bold">
              {t("Fen.White")}
            </Text>
            <Text ta="center" fw="bold">
              {t("Fen.Black")}
            </Text>
          </Group>
          <Divider mt="md" />
          <ScrollArea viewportRef={parentRef} flex={1} mih="16rem" offsetScrollbars="y">
            <Box
              style={{
                height: rowVirtualizer.getTotalSize(),
                width: "100%",
                position: "relative",
              }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const white = whiteOpenings[virtualRow.index];
                const black = blackOpenings[virtualRow.index];
                return (
                  <Box
                    key={virtualRow.index}
                    ref={rowVirtualizer.measureElement}
                    data-index={virtualRow.index}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <Group grow>
                      {white ? (
                        <OpeningDetail
                          opening={white}
                          totalGames={whiteGames}
                          pending={gameOpen.pending}
                          onOpen={() => gameOpen.activate({ name: white.name, color: "white" })}
                        />
                      ) : (
                        <div />
                      )}
                      {black ? (
                        <OpeningDetail
                          opening={black}
                          totalGames={blackGames}
                          pending={gameOpen.pending}
                          onOpen={() => gameOpen.activate({ name: black.name, color: "black" })}
                        />
                      ) : (
                        <div />
                      )}
                    </Group>
                    <Divider />
                  </Box>
                );
              })}
            </Box>
          </ScrollArea>
        </>
      )}
    </Stack>
  );
}

function OpeningDetail({
  opening,
  totalGames,
  pending,
  onOpen,
}: {
  opening: OpeningStats;
  totalGames: number;
  pending: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const openingRate = opening.games / totalGames;
  return (
    <Stack py="sm" gap={4}>
      <UnstyledButton
        type="button"
        className={classes.link}
        aria-busy={pending}
        onClick={() => void onOpen()}
      >
        <Text component="span" lineClamp={2}>
          {opening.name}
        </Text>
      </UnstyledButton>
      <div className={classes.figures} data-opening-figures>
        <Text size="sm">
          {opening.games} {t("Common.Games")} · {t("Databases.OpeningTree.Score")}{" "}
          {formatScorePercent(opening.won, opening.draw, opening.lost)}
        </Text>
        <Text size="sm" c="dimmed">
          {t("Home.Personal.Openings.Share", {
            defaultValue: "{{share}} of games",
            share: `${(openingRate * 100).toFixed(1)}%`,
          })}
        </Text>
      </div>
      <ResultsChart won={opening.won} draw={opening.draw} lost={opening.lost} size="1.5rem" />
    </Stack>
  );
}

export default OpeningsPanel;
