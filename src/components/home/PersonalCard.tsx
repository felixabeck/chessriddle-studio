import {
  Box,
  Center,
  Flex,
  Loader,
  Paper,
  SegmentedControl,
  Stack,
  Tabs,
  Text,
} from "@mantine/core";
import { Info } from "lucide-react";
import { useContext, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import type { PlayerGameInfo } from "@/bindings";
import { IconAction } from "@/components/common/IconAction";
import type { DatabaseViewStore } from "@/state/store/database";
import { DatabaseViewStateContext } from "../databases/DatabaseViewStateContext";
import FideInfo from "../common/FideInfo";
import OpeningsPanel, { type AccountOpeningSource } from "./PersonalCardPanels/OpeningsPanel";
import OverviewPanel from "./PersonalCardPanels/OverviewPanel";
import {
  busiestRatingLine,
  playerGameCount,
  statisticsSites,
} from "./PersonalCardPanels/overviewStatistics";
import RatingsPanel from "./PersonalCardPanels/RatingsPanel";
import { PlayerSelect } from "./PlayerSelect";
import PlayerOpeningTree from "../databases/PlayerOpeningTree";
import PlayerPreparation from "../databases/PlayerPreparation";
import { databaseHandleKey } from "@/utils/db";
import type { DatabaseHandle, Player } from "@/bindings";

// A panel that scrolls keeps its content clear of the scrollbar: a reserved gutter plus right
// padding, so neither text nor bars end up under it.
const SCROLLING_PANEL_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  scrollbarGutter: "stable",
  paddingRight: "1.25rem",
};

/**
 * A database player's downloaded online games for the Overview and Ratings tabs. They are kept
 * apart from the over-the-board games: ratings of different sites are different scales.
 */
export type OnlineStatistics =
  | { kind: "pending" }
  | { kind: "unavailable" }
  | {
      kind: "ready";
      info: PlayerGameInfo;
      databasePlayer: { player: Pick<Player, "id">; file: DatabaseHandle };
    };

type StatisticsSource = "overTheBoard" | "online";

function PersonalPlayerCard({
  name,
  playerKey,
  setPlayerKey,
  info,
  isDatabase,
  headerAction,
  notice,
  databasePlayer,
  openingSources,
  online,
}: {
  name: string;
  /**
   * The selected account player's key; absent for a database player, whose panels offer a
   * Website filter only for its online games.
   */
  playerKey?: string;
  setPlayerKey?: (playerKey: string) => void;
  info: PlayerGameInfo;
  isDatabase?: boolean;
  /** A small action in the name line, left of the info button. */
  headerAction?: ReactNode;
  /** Shown under the name line. */
  notice?: ReactNode;
  databasePlayer?: { player: Player; file: DatabaseHandle };
  /** The account player's databases for the opening tree; absent leaves the Openings tab a list. */
  openingSources?: AccountOpeningSource[];
  /** A linked opponent's online games; absent shows the Overview and Ratings tabs without a switch. */
  online?: OnlineStatistics;
}) {
  const { t } = useTranslation();
  const store = useContext(DatabaseViewStateContext)!;
  const activeTab = useStore(store, (s) => s.players.activeTab);
  const setActiveTab = useStore(store, (s) => s.setPlayersActiveTab);
  const hasPreparation = Boolean(isDatabase && databasePlayer);
  // A card without a Preparation tab shows Overview while the stored tab choice stays as it is.
  const shownTab = activeTab === "preparation" && !hasPreparation ? "overview" : activeTab;

  const [opened, setOpened] = useState(false);
  const [source, setSource] = useState<StatisticsSource>("overTheBoard");
  const onlineInfo = online?.kind === "ready" ? online.info : undefined;
  const onlineFilters = useMemo(
    () =>
      onlineInfo && {
        sites: statisticsSites(onlineInfo),
        initial: busiestRatingLine(onlineInfo),
      },
    [onlineInfo],
  );
  const showOnline = online !== undefined && source === "online";
  const sourceSwitch = online && (
    <SourceSwitch
      value={source}
      onChange={setSource}
      overTheBoardGames={playerGameCount(info)}
      onlineGames={onlineInfo && playerGameCount(onlineInfo)}
    />
  );

  return (
    <Paper
      h="100%"
      shadow="sm"
      p="md"
      withBorder
      style={{ overflow: "hidden", display: "flex", flexDirection: "column" }}
    >
      <FideInfo key={name} opened={opened} setOpened={setOpened} name={name} />
      {headerAction ? (
        // The name takes the free space; the action and the info button wrap beneath it when the
        // card is too narrow for both, so neither is clipped and the name never runs under them.
        <Flex align="center" justify="flex-end" gap="xs" wrap="wrap" data-card-name-line>
          <Text fz="lg" fw={500} ta="center" className="wrap-anywhere" flex="1 1 10rem" miw={0}>
            {name}
          </Text>
          <Flex align="center" gap="xs" wrap="nowrap">
            {headerAction}
            <IconAction label={t("Databases.FIDE.Info")} onClick={() => setOpened(true)}>
              <Info />
            </IconAction>
          </Flex>
        </Flex>
      ) : (
        <Box pos="relative">
          {name !== "Stats" && (
            <IconAction
              label={t("Databases.FIDE.Info")}
              pos="absolute"
              right={0}
              onClick={() => setOpened(true)}
            >
              <Info />
            </IconAction>
          )}
          {playerKey !== undefined && setPlayerKey ? (
            <Flex justify="center">
              <PlayerSelect
                ariaLabel={t("Home.Accounts.PlayerName")}
                value={playerKey}
                onChange={setPlayerKey}
              />
            </Flex>
          ) : (
            <Text fz="lg" fw={500} ta="center" className="wrap-anywhere">
              {name}
            </Text>
          )}
        </Box>
      )}
      {notice}
      <Tabs
        mt="xs"
        keepMounted={false}
        value={shownTab}
        onChange={(v) => setActiveTab(v as DatabaseViewStore["players"]["activeTab"])}
        variant="outline"
        flex={1}
        style={{
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Tabs.List>
          <Tabs.Tab value="overview">{t("Home.Personal.Overview")}</Tabs.Tab>
          <Tabs.Tab value="ratings">{t("Home.Personal.Ratings")}</Tabs.Tab>
          <Tabs.Tab value="openings">{t("Home.Personal.Openings")}</Tabs.Tab>
          {hasPreparation && (
            <Tabs.Tab value="preparation">
              {t("Home.Personal.Preparation", { defaultValue: "Preparation" })}
            </Tabs.Tab>
          )}
        </Tabs.List>
        <Tabs.Panel value="overview" style={SCROLLING_PANEL_STYLE}>
          {sourceSwitch}
          {showOnline ? (
            <OnlinePanel online={online}>
              {(ready) => (
                <OverviewPanel
                  playerKey=""
                  info={ready.info}
                  isDatabase
                  databasePlayer={ready.databasePlayer}
                  onlineSites={onlineFilters?.sites}
                />
              )}
            </OnlinePanel>
          ) : (
            <OverviewPanel
              playerKey={playerKey ?? ""}
              info={info}
              isDatabase={isDatabase}
              databasePlayer={databasePlayer}
            />
          )}
        </Tabs.Panel>
        <Tabs.Panel
          value="openings"
          style={isDatabase && databasePlayer ? SCROLLING_PANEL_STYLE : { overflow: "hidden" }}
        >
          {isDatabase && databasePlayer ? (
            <PlayerOpeningTree {...databasePlayer} />
          ) : (
            <OpeningsPanel
              playerKey={playerKey ?? ""}
              name={name}
              info={info}
              isDatabase={isDatabase}
              sources={openingSources}
            />
          )}
        </Tabs.Panel>
        <Tabs.Panel value="ratings" style={SCROLLING_PANEL_STYLE}>
          {sourceSwitch}
          {showOnline ? (
            <OnlinePanel online={online}>
              {(ready) => (
                <RatingsPanel
                  playerKey=""
                  info={ready.info}
                  isDatabase
                  onlineFilters={onlineFilters}
                />
              )}
            </OnlinePanel>
          ) : (
            <RatingsPanel playerKey={playerKey ?? ""} info={info} isDatabase={isDatabase} />
          )}
        </Tabs.Panel>
        {hasPreparation && databasePlayer && (
          <Tabs.Panel value="preparation" style={SCROLLING_PANEL_STYLE}>
            <PlayerPreparation
              key={`${databaseHandleKey(databasePlayer.file)}:${databasePlayer.player.id}`}
              {...databasePlayer}
            />
          </Tabs.Panel>
        )}
      </Tabs>
    </Paper>
  );
}

/** Over the board or online, each with its game count; the online count appears once read. */
function SourceSwitch({
  value,
  onChange,
  overTheBoardGames,
  onlineGames,
}: {
  value: StatisticsSource;
  onChange: (source: StatisticsSource) => void;
  overTheBoardGames: number;
  onlineGames: number | undefined;
}) {
  const { t } = useTranslation();
  const onlineLabel = t("Databases.OpeningTree.Online");
  return (
    <SegmentedControl
      mt="sm"
      fullWidth
      data-statistics-source
      value={value}
      onChange={(next) => onChange(next as StatisticsSource)}
      data={[
        {
          value: "overTheBoard",
          label: `${t("Databases.OpeningTree.OverTheBoard")} · ${overTheBoardGames}`,
        },
        {
          value: "online",
          label: onlineGames === undefined ? onlineLabel : `${onlineLabel} · ${onlineGames}`,
        },
      ]}
    />
  );
}

/** The online games' panel once they are read; a loader before, a notice when they cannot be. */
function OnlinePanel({
  online,
  children,
}: {
  online: OnlineStatistics;
  children: (ready: Extract<OnlineStatistics, { kind: "ready" }>) => ReactNode;
}) {
  const { t } = useTranslation();
  if (online.kind === "ready") return children(online);
  return (
    <Center py="xl">
      {online.kind === "pending" ? (
        <Stack align="center">
          <Text fw="bold">{t("Databases.Player.ProcessingData")}</Text>
          <Loader />
        </Stack>
      ) : (
        <Text ta="center">{t("Databases.OpeningTree.OnlineUnavailable")}</Text>
      )}
    </Center>
  );
}

export default PersonalPlayerCard;
