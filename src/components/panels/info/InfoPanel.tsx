import { useOwnerTab } from "@/state/tabScope";
import { Box, Divider, Group, ScrollArea, Stack, Text } from "@mantine/core";
import { use, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { isTreeViewDeferred, useTreeView } from "@/state/deferredTreeView";
import { type DatabaseHandle } from "@/bindings";
import GameInfo from "@/components/common/GameInfo";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { getTabFile, isFileBackedTab, matchesFileGameTab, sameTabOwner } from "@/utils/tabs";
import FenSearch from "./FenSearch";
import FileInfo from "./FileInfo";
import GameSelectorAccordion from "./GameSelectorAccordion";
import classes from "./InfoPanel.module.css";
import PgnInput from "./PgnInput";
import { getStats } from "@/utils/repertoire";
import { useDatabaseList } from "@/hooks/useDatabaseList";
import { sameDatabaseHandle } from "@/utils/db";
import { databaseRouteTarget } from "@/components/databases/databaseRoute";
import { useNavigate } from "@tanstack/react-router";
import { useActiveDatabaseViewStore } from "@/state/store/database";
import { getFileGameName } from "@/utils/files";
import type { GameSelectorRow } from "./GameSelector";

function InfoPanel({ addGame }: { addGame?: () => void }) {
  const store = use(TreeStateContext)!;
  const view = useTreeView(store);
  const stats = isTreeViewDeferred(store) ? { total: 0, leafs: 0, depth: 0 } : getStats(view);
  const headers = useStore(store, (s) => s.headers);
  const [games, setGames] = useState<Map<number, GameSelectorRow>>(new Map());
  const [currentTab, setCurrentTab] = useOwnerTab();
  const tabFile = getTabFile(currentTab);
  const isReportoire = tabFile?.metadata.type === "repertoire";
  const derivedTabName = tabFile ? getFileGameName(headers, tabFile) : undefined;
  const previousTabTitle = useRef({ tab: currentTab, store, name: derivedTabName });

  useEffect(() => {
    const previous = previousTabTitle.current;
    previousTabTitle.current = { tab: currentTab, store, name: derivedTabName };
    // Mounting or changing owners establishes the baseline, preserving a manual tab name.
    if (
      derivedTabName === undefined ||
      previous.name === derivedTabName ||
      previous.store !== store ||
      !isFileBackedTab(currentTab) ||
      !previous.tab ||
      !sameTabOwner(currentTab, previous.tab) ||
      !matchesFileGameTab(previous.tab, currentTab.gameOrigin)
    )
      return;
    setCurrentTab((tab) =>
      sameTabOwner(tab, currentTab) && matchesFileGameTab(tab, currentTab.gameOrigin)
        ? { ...tab, name: derivedTabName }
        : tab,
    );
  }, [currentTab, derivedTabName, setCurrentTab, store]);

  const { t } = useTranslation();

  return (
    <Stack h="100%" gap={0}>
      {currentTab?.gameOrigin.kind === "database" && (
        <DatabaseInfo path={currentTab.gameOrigin.database} id={currentTab.gameOrigin.gameId} />
      )}
      <GameSelectorAccordion games={games} setGames={setGames} addGame={addGame} />
      <ScrollArea pb="sm">
        <FileInfo setGames={setGames} />
        <Stack px="sm">
          <GameInfo headers={headers} simplified={isReportoire} />
          <FenSearch />
          <PgnInput />

          <Group>
            <Text fz="xs" c="dimmed">
              {t("PgnInput.Variations")}: {stats.leafs}
            </Text>
            <Text fz="xs" c="dimmed">
              {t("PgnInput.MaxDepth")}: {stats.depth}
            </Text>
            <Text fz="xs" c="dimmed">
              {t("PgnInput.TotalMoves")}: {stats.total}
            </Text>
          </Group>
        </Stack>
      </ScrollArea>
    </Stack>
  );
}

function DatabaseInfo({ path, id: _id }: { path: DatabaseHandle; id: number }) {
  const { t } = useTranslation();
  const { data: databases, isLoading } = useDatabaseList();

  const dbInfo = databases?.databases.find((db) => sameDatabaseHandle(db.file, path));
  const navigate = useNavigate();
  const setActiveDatabase = useActiveDatabaseViewStore((store) => store.setDatabase);

  if (isLoading || !dbInfo || dbInfo.type !== "success") {
    return null;
  }
  return (
    <Stack gap={0}>
      <Box
        className={classes.databaseCard}
        onClick={async () => {
          if (setActiveDatabase(dbInfo) !== true) return;
          await navigate(databaseRouteTarget(dbInfo));
        }}
      >
        <Text tt="uppercase" c="dimmed" fw={700} size="xs">
          {t("Board.Tabs.Database")}
        </Text>
        <Text fw="bold">{dbInfo.title}</Text>
        <Text size="xs" c="dimmed">
          {dbInfo.description}
        </Text>
      </Box>
      <Divider />
    </Stack>
  );
}

export default InfoPanel;
