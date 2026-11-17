import { Box, Flex, Paper, Tabs, Text } from "@mantine/core";
import { Info } from "lucide-react";
import { useContext, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import type { PlayerGameInfo } from "@/bindings";
import { IconAction } from "@/components/common/IconAction";
import type { DatabaseViewStore } from "@/state/store/database";
import { DatabaseViewStateContext } from "../databases/DatabaseViewStateContext";
import FideInfo from "../databases/FideInfo";
import OpeningsPanel, { type AccountOpeningSource } from "./PersonalCardPanels/OpeningsPanel";
import OverviewPanel from "./PersonalCardPanels/OverviewPanel";
import RatingsPanel from "./PersonalCardPanels/RatingsPanel";
import { PlayerSelect } from "./PlayerSelect";
import PlayerOpeningTree from "../databases/PlayerOpeningTree";
import type { DatabaseHandle, Player } from "@/bindings";

function PersonalPlayerCard({
  name,
  playerKey,
  setPlayerKey,
  info,
  isDatabase,
  notice,
  databasePlayer,
  openingSources,
}: {
  name: string;
  /** The selected account player's key; absent for a database player, whose panels show no website filter. */
  playerKey?: string;
  setPlayerKey?: (playerKey: string) => void;
  info: PlayerGameInfo;
  isDatabase?: boolean;
  notice?: ReactNode;
  databasePlayer?: { player: Player; file: DatabaseHandle };
  /** The account player's databases for the opening tree; absent leaves the Openings tab a list. */
  openingSources?: AccountOpeningSource[];
}) {
  const { t } = useTranslation();
  const store = useContext(DatabaseViewStateContext)!;
  const activeTab = useStore(store, (s) => s.players.activeTab);
  const setActiveTab = useStore(store, (s) => s.setPlayersActiveTab);

  const [opened, setOpened] = useState(false);

  return (
    <Paper
      h="100%"
      shadow="sm"
      p="md"
      withBorder
      style={{ overflow: "hidden", display: "flex", flexDirection: "column" }}
    >
      <FideInfo key={name} opened={opened} setOpened={setOpened} name={name} />
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
      {notice}
      <Tabs
        mt="xs"
        keepMounted={false}
        value={activeTab}
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
        </Tabs.List>
        <Tabs.Panel value="overview" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          <OverviewPanel
            playerKey={playerKey ?? ""}
            info={info}
            isDatabase={isDatabase}
            databasePlayer={databasePlayer}
          />
        </Tabs.Panel>
        <Tabs.Panel
          value="openings"
          style={
            isDatabase && databasePlayer
              ? {
                  flex: 1,
                  minHeight: 0,
                  overflowY: "auto",
                  scrollbarGutter: "stable",
                  paddingRight: "1.25rem",
                }
              : { overflow: "hidden" }
          }
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
        <Tabs.Panel value="ratings">
          <RatingsPanel playerKey={playerKey ?? ""} info={info} isDatabase={isDatabase} />
        </Tabs.Panel>
      </Tabs>
    </Paper>
  );
}

export default PersonalPlayerCard;
