import { useTabAtom, useOwnerTab } from "@/state/tabScope";
import { tauri } from "@/platform/tauri";
import {
  Alert,
  Group,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Tabs,
  Text,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { Link } from "@tanstack/react-router";
import { useAtom, useAtomValue } from "jotai";
import { memo, useContext, useEffect } from "react";
import { useTranslation } from "react-i18next";
import useSWR from "swr/immutable";
import { useNativeRequestOwner } from "@/hooks/useNativeRequestOwner";
import { useDatabaseList } from "@/hooks/useDatabaseList";
import { match } from "ts-pattern";
import { useStore } from "zustand";
import { type NormalizedGame } from "@/bindings";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import {
  dbTabFamily,
  dbTypeFamily,
  localOptionsFamily,
  pinnedExplorerDatabaseFamily,
  lichessOptionsAtom,
  masterOptionsAtom,
  referenceDbAtom,
  sessionsAtom,
} from "@/state/atoms";
import {
  databaseHandleFromKey,
  databaseHandleKey,
  type Opening,
  type LocalOptions,
} from "@/utils/db";
import { formatNumber } from "@/utils/format";
import {
  convertToNormalized,
  getLichessGames,
  getMasterGames,
  type PositionData,
} from "@/utils/lichess/api";
import type { LichessGamesOptions, MasterGamesOptions } from "@/utils/lichess/explorer";
import DatabaseLoader from "./DatabaseLoader";
import GamesTable from "./GamesTable";
import NoDatabaseWarning from "./NoDatabaseWarning";
import OpeningsTable from "./OpeningsTable";
import LichessOptionsPanel from "./options/LichessOptionsPanel";
import LocalOptionsPanel from "./options/LocalOptionsPanel";
import { useCollectionCurrency } from "@/state/linkedCollections";
import MasterOptionsPanel from "./options/MastersOptionsPanel";
import { fetchLocalOpening, useLocalExplorer } from "./useLocalExplorer";

export type { LocalOptions } from "@/utils/db";

export type DBType =
  | { type: "local"; options: LocalOptions }
  | {
      type: "lch_all";
      options: LichessGamesOptions;
      fen: string;
      handle: string;
    }
  | {
      type: "lch_master";
      options: MasterGamesOptions;
      fen: string;
      handle: string;
    };

type OpeningData = {
  openings: Opening[];
  games: NormalizedGame[];
  gameFailures?: Awaited<ReturnType<typeof convertToNormalized>>["failures"];
};

export async function fetchOnlineOpening<T>(
  fetcher: (fen: string, options: T, handle: string) => Promise<PositionData>,
  fen: string,
  options: T,
  handle: string,
  signal?: AbortSignal,
) {
  const data = await fetcher(fen, options, handle);
  if (signal?.aborted) {
    throw new DOMException("Cancellation", "AbortError");
  }
  const normalized = await convertToNormalized(data.topGames || data.recentGames || [], { signal });
  return {
    openings: data.moves.map((move) => ({
      move: move.san,
      white: move.white,
      black: move.black,
      draw: move.draws,
    })),
    games: normalized.games,
    gameFailures: normalized.failures,
  };
}

export async function fetchOpening(
  db: DBType,
  tab: string,
  signal?: AbortSignal,
): Promise<OpeningData> {
  return match(db)
    .with({ type: "lch_all" }, async ({ fen, options, handle }) =>
      fetchOnlineOpening(getLichessGames, fen, options, handle, signal),
    )
    .with({ type: "lch_master" }, async ({ fen, options, handle }) =>
      fetchOnlineOpening(getMasterGames, fen, options, handle, signal),
    )
    .with({ type: "local" }, ({ options }) => fetchLocalOpening(options, tab, signal))
    .exhaustive();
}

function DatabasePanel() {
  const { t } = useTranslation();

  const store = useContext(TreeStateContext)!;
  const fen = useStore(store, (s) => s.currentNode().fen);
  const [referenceDatabase, setReferenceDatabase] = useAtom(referenceDbAtom);
  const [pinnedDatabase, setPinnedDatabase] = useAtom(useTabAtom(pinnedExplorerDatabaseFamily));
  const selectedDatabase = pinnedDatabase ?? referenceDatabase;
  const currency = useCollectionCurrency(selectedDatabase);
  useEffect(() => {
    const current = currency.collection?.database;
    if (
      current &&
      selectedDatabase &&
      databaseHandleKey(current) !== databaseHandleKey(selectedDatabase)
    )
      (pinnedDatabase ? setPinnedDatabase : setReferenceDatabase)(current);
  }, [
    currency.collection?.database,
    selectedDatabase,
    pinnedDatabase,
    setPinnedDatabase,
    setReferenceDatabase,
  ]);
  const sessions = useAtomValue(sessionsAtom);
  const [debouncedFen] = useDebouncedValue(fen, 50);
  const [lichessOptions, setLichessOptions] = useAtom(lichessOptionsAtom);
  const [masterOptions, setMasterOptions] = useAtom(masterOptionsAtom);
  const [localOptions, setLocalOptions] = useAtom(useTabAtom(localOptionsFamily));
  const [db, setDb] = useAtom(useTabAtom(dbTypeFamily));
  const explorerHandle = sessions.find((session) => session.lichess?.handle)?.lichess?.handle;
  const missingExplorerAuthentication = db !== "local" && !explorerHandle;

  const { data: databases, error: databasesError } = useDatabaseList(db === "local");

  const readableDatabases = databasesError
    ? []
    : (databases?.databases ?? []).filter((d) => d.type === "success");
  const effectiveReferenceDatabase = databaseHandleFromKey(
    readableDatabases,
    selectedDatabase ? databaseHandleKey(selectedDatabase) : null,
  );
  const dbSelectData = readableDatabases.map((d) => ({
    value: databaseHandleKey(d.file),
    label: d.title || d.filename,
  }));
  const selectedReferenceDatabase = effectiveReferenceDatabase
    ? databaseHandleKey(effectiveReferenceDatabase)
    : null;

  useEffect(() => {
    if (db === "local") {
      setLocalOptions((q) => ({ ...q, fen: debouncedFen }));
    }
  }, [debouncedFen, setLocalOptions, setMasterOptions, setLichessOptions, db]);

  useEffect(() => {
    if (db === "local") {
      setLocalOptions((q) => ({ ...q, path: effectiveReferenceDatabase }));
    }
  }, [effectiveReferenceDatabase, setLocalOptions, db]);

  const dbType: DBType = match(db)
    .with("local", (v) => ({
      type: v,
      options: { ...localOptions, path: effectiveReferenceDatabase },
    }))
    .with("lch_all", (v) => ({
      type: v,
      options: lichessOptions,
      fen: debouncedFen,
      handle: explorerHandle ?? "",
    }))
    .with("lch_master", (v) => ({
      type: v,
      options: masterOptions,
      fen: debouncedFen,
      handle: explorerHandle ?? "",
    }))
    .exhaustive();

  const [tab] = useOwnerTab();
  const [tabType, setTabType] = useAtom(useTabAtom(dbTabFamily));
  const localExplorer = useLocalExplorer(
    { ...localOptions, path: effectiveReferenceDatabase },
    db === "local" && tabType !== "options",
    tab?.value || "",
  );
  const openingKey =
    tabType !== "options" && !missingExplorerAuthentication && db !== "local"
      ? currency.collection
        ? ([dbType, currency.collection.generation] as const)
        : dbType
      : null;
  const openingOwner = useNativeRequestOwner(openingKey);

  const {
    data: onlineData,
    isLoading: onlineLoading,
    error: openingError,
  } = useSWR(openingKey, () =>
    openingOwner!.run((signal) => fetchOpening(dbType, tab?.value || "", signal)),
  );
  const openingData: OpeningData | undefined = db === "local" ? localExplorer : onlineData;
  const isLoading = db === "local" ? localExplorer.loading : onlineLoading;
  const error = db === "local" ? localExplorer.error : openingError;

  const grandTotal = openingData?.openings?.reduce(
    (acc, curr) => acc + curr.black + curr.white + curr.draw,
    0,
  );
  const reportedGameCount =
    (openingData?.games.length ?? 0) + (openingData?.gameFailures?.length ?? 0);
  const matches = Math.max(grandTotal || 0, reportedGameCount);
  const failedGames = openingData?.gameFailures
    ?.map(({ item }) => {
      const names = [item.white.name.trim(), item.black.name.trim()].filter(Boolean);
      return names.join(" - ") || item.id;
    })
    .join(", ");
  const hasGameFailures = (openingData?.gameFailures?.length ?? 0) > 0;

  const header = (
    <>
      <Group justify="space-between" w="100%" wrap="nowrap">
        <Group>
          <SegmentedControl
            data={[
              { label: t("Board.Database.Local"), value: "local" },
              { label: t("Board.Database.LichessAll"), value: "lch_all" },
              { label: t("Board.Database.LichessMaster"), value: "lch_master" },
            ]}
            value={db}
            onChange={(value) => setDb(value as "local" | "lch_all" | "lch_master")}
          />

          {db === "local" && (
            <Select
              data={dbSelectData}
              value={selectedReferenceDatabase}
              onChange={async (value) => {
                await tauri.clearGames();
                (pinnedDatabase ? setPinnedDatabase : setReferenceDatabase)(
                  databaseHandleFromKey(readableDatabases, value),
                );
              }}
              placeholder={t("Board.Database.SelectReference")}
              size="sm"
              flex={1}
              maw={200}
              allowDeselect={false}
            />
          )}
        </Group>

        {tabType !== "options" && (
          <Text style={{ whiteSpace: "nowrap" }}>
            {t("Board.Database.Matches", {
              matches: formatNumber(matches),
            })}
          </Text>
        )}
      </Group>
      <DatabaseLoader
        isLoading={isLoading}
        tab={db === "local" ? localExplorer.progressId : (tab?.value ?? null)}
      />
    </>
  );

  return (
    <Stack h="100%" gap={0}>
      <Tabs
        defaultValue="stats"
        orientation="vertical"
        placement="right"
        value={tabType}
        onChange={(v) => setTabType(v!)}
        display="flex"
        flex={1}
        style={{ overflow: "hidden" }}
      >
        <Tabs.List>
          <Tabs.Tab
            value="stats"
            disabled={dbType.type === "local" && dbType.options.type === "partial"}
          >
            {t("Board.Database.Stats")}
          </Tabs.Tab>
          <Tabs.Tab value="games">{t("Board.Database.Games")}</Tabs.Tab>
          <Tabs.Tab value="options">{t("Board.Database.Options")}</Tabs.Tab>
        </Tabs.List>

        <PanelWithError
          value="stats"
          error={error}
          type={db}
          header={header}
          missingExplorerAuthentication={missingExplorerAuthentication}
          hasReferenceDatabase={!!effectiveReferenceDatabase}
        >
          <OpeningsTable openings={openingData?.openings || []} loading={isLoading} />
        </PanelWithError>
        <PanelWithError
          value="games"
          error={error}
          type={db}
          header={header}
          missingExplorerAuthentication={missingExplorerAuthentication}
          hasReferenceDatabase={!!effectiveReferenceDatabase}
        >
          {hasGameFailures && (
            <Alert color="warning" style={{ flexShrink: 0 }}>
              {openingData?.games.length
                ? t("Board.Database.GamesIncomplete", {
                    defaultValue: "Could not load these games: {{games}}",
                    games: failedGames,
                  })
                : t("Board.Database.GamesFailed", {
                    defaultValue: "Could not load games: {{games}}",
                    games: failedGames,
                  })}
            </Alert>
          )}
          {(!hasGameFailures || !!openingData?.games.length) && (
            <GamesTable
              games={openingData?.games || []}
              loading={isLoading}
              databasePath={dbType.type === "local" ? dbType.options.path : null}
            />
          )}
        </PanelWithError>
        <PanelWithError
          value="options"
          error={error}
          type={db}
          header={header}
          missingExplorerAuthentication={missingExplorerAuthentication}
          hasReferenceDatabase={!!effectiveReferenceDatabase}
        >
          <ScrollArea flex={1} offsetScrollbars pt="sm">
            {match(db)
              .with("local", () => <LocalOptionsPanel boardFen={debouncedFen} />)
              .with("lch_all", () => <LichessOptionsPanel />)
              .with("lch_master", () => <MasterOptionsPanel />)
              .exhaustive()}
          </ScrollArea>
        </PanelWithError>
      </Tabs>
    </Stack>
  );
}

function PanelWithError(props: {
  value: string;
  error: Error | string | undefined;
  type: string;
  header: React.ReactNode;
  children: React.ReactNode;
  missingExplorerAuthentication: boolean;
  hasReferenceDatabase: boolean;
}) {
  const { t } = useTranslation();
  let children = props.children;
  if (props.missingExplorerAuthentication && props.type !== "local") {
    children = (
      <Alert color="warning">
        {t("Board.Database.ExplorerAuthRequired1")}{" "}
        <Link to="/accounts">{t("Home.Accounts.Users")}</Link>{" "}
        {t("Board.Database.ExplorerAuthRequired2")}
      </Alert>
    );
  }
  if (props.error) {
    children = <Alert color="danger">{props.error.toString()}</Alert>;
  }
  if (props.type === "local" && !props.hasReferenceDatabase) {
    children = <NoDatabaseWarning />;
  }

  return (
    <Tabs.Panel
      py="xs"
      px="sm"
      value={props.value}
      flex={1}
      style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}
    >
      {props.header}
      {children}
    </Tabs.Panel>
  );
}

export default memo(DatabasePanel);
