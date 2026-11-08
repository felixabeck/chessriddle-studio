import { Box, Flex, Paper, Select, Tabs, Text } from "@mantine/core";
import { Info } from "lucide-react";
import { useAtomValue } from "jotai";
import { useContext, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import type { PlayerGameInfo } from "@/bindings";
import { sessionsAtom } from "@/state/atoms";
import { IconAction } from "@/components/common/IconAction";
import type { DatabaseViewStore } from "@/state/store/database";
import { sessionPlayerName } from "@/utils/session";
import { DatabaseViewStateContext } from "../databases/DatabaseViewStateContext";
import FideInfo from "../databases/FideInfo";
import OpeningsPanel from "./PersonalCardPanels/OpeningsPanel";
import OverviewPanel from "./PersonalCardPanels/OverviewPanel";
import RatingsPanel from "./PersonalCardPanels/RatingsPanel";
import PlayerOpeningTree from "../databases/PlayerOpeningTree";
import type { DatabaseHandle, Player } from "@/bindings";

function PersonalPlayerCard({
  name,
  setName,
  info,
  isDatabase,
  notice,
  databasePlayer,
}: {
  name: string;
  setName?: (name: string) => void;
  info: PlayerGameInfo;
  isDatabase?: boolean;
  notice?: ReactNode;
  databasePlayer?: { player: Player; file: DatabaseHandle };
}) {
  const { t } = useTranslation();
  const store = useContext(DatabaseViewStateContext)!;
  const activeTab = useStore(store, (s) => s.players.activeTab);
  const setActiveTab = useStore(store, (s) => s.setPlayersActiveTab);

  const [opened, setOpened] = useState(false);
  const sessions = useAtomValue(sessionsAtom);
  const players = Array.from(new Set(sessions.map(sessionPlayerName)));

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
        {setName ? (
          <Flex justify="center">
            <Select
              value={name}
              data={players}
              onChange={(e) => setName(e || "")}
              clearable={false}
              allowDeselect={false}
              fw="bold"
              styles={{
                input: {
                  textAlign: "center",
                  fontSize: "1.25rem",
                },
              }}
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
            playerName={name}
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
            <OpeningsPanel playerName={name} info={info} isDatabase={isDatabase} />
          )}
        </Tabs.Panel>
        <Tabs.Panel value="ratings">
          <RatingsPanel playerName={name} info={info} isDatabase={isDatabase} />
        </Tabs.Panel>
      </Tabs>
    </Paper>
  );
}

export default PersonalPlayerCard;
