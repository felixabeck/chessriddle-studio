import { Box, Button, Center, Group, Loader, Stack, Tabs, Text, Title } from "@mantine/core";
import { ArrowLeft, ChessKnight, Trophy, User } from "lucide-react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useCollectionCurrency } from "@/state/linkedCollections";
import { useEffect, useMemo, useState } from "react";
import { useSetAtom } from "jotai";
import { recordLastOpenedAtom } from "@/state/atoms";
import { useTranslation } from "react-i18next";
import GameTable from "@/components/databases/GameTable";
import { IconAction } from "@/components/common/IconAction";
import PlayerTable from "@/components/databases/PlayerTable";
import {
  activeDatabaseViewStore,
  type DatabaseViewStore,
  useActiveDatabaseViewStore,
} from "@/state/store/database";
import { DatabaseViewStateContext } from "./DatabaseViewStateContext";
import TournamentTable from "./TournamentTable";
import { useDatabaseList } from "@/hooks/useDatabaseList";
import { resolveDatabaseRoute } from "./databaseRoute";
import { listingFailure } from "@/components/files/listingFailure";
import { databaseLoadFailureMessage } from "./databaseLoadFailure";
import { databaseHandleKey } from "@/utils/db";
import { useRootFontPx } from "@/hooks/useRootFontPx";
import { databasePaneGeometry, DatabaseLayoutContext } from "@/state/databaseLayout";
import classes from "./GridLayout.module.css";

function useViewWidth() {
  const [node, ref] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!node) return;
    let active = true;
    const observer = new ResizeObserver((entries) => {
      if (!active) return;
      const entry = entries.find((entry) => entry.target === node);
      if (entry) {
        setWidth(
          entry.borderBoxSize?.[0]?.inlineSize ??
            entry.contentBoxSize?.[0]?.inlineSize ??
            entry.contentRect.width,
        );
      }
    });
    observer.observe(node);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [node]);

  return { ref, width };
}

function DatabaseView() {
  const { t } = useTranslation();
  const { ref, width } = useViewWidth();
  const rootFont = useRootFontPx();
  const geometry = { ...databasePaneGeometry(width, rootFont), rootFont };
  const { compact } = geometry;
  const database = useActiveDatabaseViewStore((s) => s.database);
  const mode = useActiveDatabaseViewStore((s) => s.activeTab);
  const setActiveTab = useActiveDatabaseViewStore((s) => s.setActiveTab);
  const { databaseId } = useParams({ from: "/databases/$databaseId" });
  const { data: databases, error, mutate } = useDatabaseList();
  const navigate = useNavigate();
  const currency = useCollectionCurrency(database?.file, database?.collection);
  useEffect(() => {
    const linked = databases?.collections?.find(
      (collection) =>
        collection.retiredDatabase && databaseHandleKey(collection.retiredDatabase) === databaseId,
    );
    if (linked?.status === "ready" && linked.database)
      void navigate({
        to: "/databases/$databaseId",
        params: { databaseId: databaseHandleKey(linked.database) },
        replace: true,
      });
  }, [databaseId, databases, navigate]);

  const resolution = useMemo(
    () => resolveDatabaseRoute(databases?.databases, databaseId, database),
    [databases, databaseId, database],
  );
  const unreadMatches = useMemo(
    () =>
      resolution.status === "not_found" &&
      database &&
      databaseHandleKey(database.file) === databaseId
        ? (databases?.unread.filter((row) => row.filename === database.filename) ?? [])
        : [],
    [resolution, database, databaseId, databases],
  );
  const preserveUnread = unreadMatches.length > 0;
  const recordLastOpened = useSetAtom(recordLastOpenedAtom);
  const shownDatabaseKey =
    resolution.status === "ready" &&
    (!resolution.database.collection ||
      (!currency.error && currency.collection?.status === "ready"))
      ? databaseHandleKey(resolution.database.file)
      : null;
  useEffect(() => {
    if (shownDatabaseKey !== null) recordLastOpened([shownDatabaseKey]);
  }, [shownDatabaseKey, recordLastOpened]);

  useEffect(() => {
    if (resolution.status === "synchronizing") {
      activeDatabaseViewStore.getState().setDatabase(resolution.database);
    } else if (
      resolution.status === "ready" &&
      resolution.database.collection?.generation !== database?.collection?.generation
    ) {
      activeDatabaseViewStore.getState().setDatabase(resolution.database);
    } else if (resolution.status === "not_found" && database && !preserveUnread) {
      activeDatabaseViewStore.getState().clearDatabase();
    }
  }, [database, resolution, preserveUnread]);

  if (resolution.status === "loading" || resolution.status === "synchronizing") {
    return (
      <Box p="sm" h="100%">
        <Center ref={ref} h="100%">
          {resolution.status === "loading" && listingFailure(error) !== "silent" ? (
            <Stack role="alert" align="center">
              <Text c="danger" className="wrap-anywhere">
                {databaseLoadFailureMessage(error, t)}
              </Text>
              <Button onClick={() => void mutate()}>
                {t("Databases.LoadRetry", { defaultValue: "Retry" })}
              </Button>
              <Link to="/library">{t("Library.Title", { defaultValue: "Library" })}</Link>
            </Stack>
          ) : (
            <Loader aria-label={t("Common.Loading")} />
          )}
        </Center>
      </Box>
    );
  }

  if (resolution.status === "unavailable") {
    return (
      <Box p="sm" h="100%">
        <Center ref={ref} h="100%">
          <Stack align="center" role="status">
            {resolution.database.upgradeFailed && (
              <Text className="wrap-anywhere">{t("Databases.UpgradeFailed.Description")}</Text>
            )}
            <Text className="wrap-anywhere">{resolution.database.error}</Text>
            <Link to="/library">{t("Library.Title")}</Link>
          </Stack>
        </Center>
      </Box>
    );
  }

  if (resolution.status === "not_found") {
    return (
      <Box p="sm" h="100%">
        <Center ref={ref} h="100%">
          <Stack align="center" role={preserveUnread ? "alert" : undefined}>
            <Text c={preserveUnread ? "danger" : "dimmed"} className="wrap-anywhere">
              {preserveUnread
                ? unreadMatches.length === 1
                  ? unreadMatches[0].error
                  : t("Databases.LoadError.Title")
                : t("Databases.NoSelection")}
            </Text>
            <Link to="/library">{t("Library.Title", { defaultValue: "Library" })}</Link>
          </Stack>
        </Center>
      </Box>
    );
  }

  const databaseForRoute = resolution.database;
  if (databaseForRoute.collection && (currency.error || currency.collection?.status !== "ready"))
    return (
      <Stack role="alert" p="md">
        <Text>
          {t("Collections.Unavailable", {
            defaultValue:
              "The search index is unavailable. Retry, or select the collection's source file again.",
          })}
        </Text>
        <Button onClick={() => void mutate()}>
          {t("Common.Retry", { defaultValue: "Retry" })}
        </Button>
        <Link to="/library">{t("Library.Title")}</Link>
      </Stack>
    );

  return (
    <Box
      p="sm"
      h="100%"
      className={classes.view}
      data-database-view
      data-compact={compact || undefined}
    >
      <DatabaseLayoutContext.Provider value={geometry}>
        <DatabaseViewStateContext.Provider value={activeDatabaseViewStore}>
          <Stack ref={ref} className={classes.viewStack}>
            <Group align="center" style={{ flexShrink: 0 }}>
              <Link to="/library">
                <IconAction label={t("Common.Back")} variant="default">
                  <ArrowLeft size="1rem" />
                </IconAction>
              </Link>
              <Title miw={0} className="wrap-anywhere">
                {databaseForRoute.title}
              </Title>
            </Group>
            <Tabs
              value={mode}
              onChange={(value) =>
                setActiveTab((value ?? "games") as DatabaseViewStore["activeTab"])
              }
              className={classes.tabs}
            >
              <Tabs.List style={{ flexShrink: 0 }}>
                <Tabs.Tab leftSection={<ChessKnight size="1rem" />} value="games">
                  {t("Common.Games")}
                </Tabs.Tab>
                <Tabs.Tab leftSection={<User size="1rem" />} value="players">
                  {t("Databases.Card.Players")}
                </Tabs.Tab>
                <Tabs.Tab leftSection={<Trophy size="1rem" />} value="tournaments">
                  {t("Databases.Settings.Events")}
                </Tabs.Tab>
              </Tabs.List>
              <Tabs.Panel value="games" className={classes.panel} pt="md">
                <GameTable />
              </Tabs.Panel>
              <Tabs.Panel value="players" className={classes.panel} pt="md">
                <PlayerTable />
              </Tabs.Panel>
              <Tabs.Panel value="tournaments" className={classes.panel} pt="md">
                <TournamentTable />
              </Tabs.Panel>
            </Tabs>
          </Stack>
        </DatabaseViewStateContext.Provider>
      </DatabaseLayoutContext.Provider>
    </Box>
  );
}

export default DatabaseView;
