import { tauri } from "@/platform/tauri";
import { Box, Divider, Group, ScrollArea, Stack, Text, UnstyledButton } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Color } from "chessops";
import { useAtom, useAtomValue } from "jotai";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PlayerGameInfo } from "@/bindings";
import { useGameOpen } from "@/components/common/gameOpen";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { fontSizeAtom, tabsAtom } from "@/state/atoms";
import { parsePGN } from "@/utils/chess";
import { createTab, runTabCreation } from "@/utils/tabs";
import { countMainPly, defaultTree } from "@/utils/treeReducer";
import classes from "./OpeningsPanel.module.css";
import { aggregateOpenings, filterPlayerStats, type OpeningStats } from "./overviewStatistics";
import ResultsChart from "./ResultsChart";
import filterClasses from "./StatisticsFilters.module.css";
import TimeControlSelector from "./TimeControlSelector";
import WebsiteAccountSelector from "./WebsiteAccountSelector";

function OpeningsPanel({
  playerName,
  info,
  isDatabase,
}: {
  playerName: string;
  info: PlayerGameInfo;
  isDatabase?: boolean;
}) {
  const { t } = useTranslation();
  const [website, setWebsite] = useState<string | null>("All websites");
  const [account, setAccount] = useState<string | null>("All accounts");
  const [timeControl, setTimeControl] = useState<string | null>(null);

  const openingData = filterPlayerStats(info, { website, account, timeControl }).flatMap(
    (site) => site.openings,
  );

  const whiteOpenings = aggregateOpenings(openingData, "white");
  const blackOpenings = aggregateOpenings(openingData, "black");
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
    estimateSize: () => 120 * (fontSize / 100),
    getScrollElement: () => parentRef.current,
  });

  return (
    <Stack gap={0} h="100%">
      <div className={filterClasses.filters}>
        {!isDatabase && (
          <WebsiteAccountSelector
            playerName={playerName}
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
      </div>

      <Group grow pt="xl">
        <Text ta="center" fw="bold">
          {t("Fen.White")}
        </Text>
        <Text ta="center" fw="bold">
          {t("Fen.Black")}
        </Text>
      </Group>
      <Divider mt="md" />
      <ScrollArea viewportRef={parentRef} flex={1}>
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
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: virtualRow.size,
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
  const openingRate = opening.games / totalGames;
  return (
    <Stack py="sm" justify="space-between">
      <Group justify="space-between" wrap="nowrap">
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
        <Text>{(openingRate * 100).toFixed(2)}%</Text>
      </Group>
      <ResultsChart
        won={opening.won}
        draw={opening.draw}
        lost={opening.lost}
        size="1.5rem"
        playerPerspective
      />
    </Stack>
  );
}

export default OpeningsPanel;
