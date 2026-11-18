import { useTabAtom, useOwnerTab } from "@/state/tabScope";
import { tauri } from "@/platform/tauri";
import { Alert, Group, SegmentedControl, Select, Tabs } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { Link } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { memo, type ReactNode, useContext, useEffect } from "react";
import { useTranslation } from "react-i18next";
import useSWR from "swr/immutable";
import { useNativeRequestOwner } from "@/hooks/useNativeRequestOwner";
import { useDatabaseList } from "@/hooks/useDatabaseList";
import { match } from "ts-pattern";
import { useStore } from "zustand";
import { type NormalizedGame } from "@/bindings";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { inlineFailureMessage } from "@/components/files/notifyError";
import {
  dbTabFamily,
  dbTypeFamily,
  localOptionsFamily,
  pinnedExplorerDatabaseFamily,
  lichessOptionsAtom,
  masterOptionsAtom,
  referenceDbAtom,
  replaceExplorerDatabaseAtom,
  sessionsAtom,
} from "@/state/atoms";
import {
  databaseHandleFromKey,
  databaseHandleKey,
  type Opening,
  type LocalOptions,
} from "@/utils/db";
import {
  convertToNormalized,
  getLichessGames,
  getMasterGames,
  type PositionData,
} from "@/utils/lichess/api";
import type { LichessGamesOptions, MasterGamesOptions } from "@/utils/lichess/explorer";
import DatabaseLoader from "./DatabaseLoader";
import ExplorerSourceHeader from "./ExplorerSourceHeader";
import { localFilterSummary } from "./filterSummary";
import GamesTable from "./GamesTable";
import NoDatabaseWarning from "./NoDatabaseWarning";
import OpeningsTable from "./OpeningsTable";
import LichessOptionsPanel from "./options/LichessOptionsPanel";
import LocalFiltersForm from "./options/LocalFiltersForm";
import { useCollectionCurrency } from "@/state/linkedCollections";
import MasterOptionsPanel from "./options/MastersOptionsPanel";
import PositionSearchControl from "./PositionSearchControl";
import { useExplorerFilters } from "./useExplorerFilters";
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
  const seen = new Set<string>();
  const games = [...(data.topGames ?? []), ...(data.recentGames ?? [])].filter((game) => {
    if (seen.has(game.id)) return false;
    seen.add(game.id);
    return true;
  });
  const normalized = await convertToNormalized(games, { signal });
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
  const replaceExplorerDatabase = useSetAtom(replaceExplorerDatabaseAtom);
  useEffect(() => {
    const current = currency.collection?.database;
    if (
      current &&
      selectedDatabase &&
      databaseHandleKey(current) !== databaseHandleKey(selectedDatabase)
    ) {
      if (pinnedDatabase) setPinnedDatabase(current);
      else replaceExplorerDatabase({ from: selectedDatabase, to: current });
    }
  }, [
    currency.collection?.database,
    selectedDatabase,
    pinnedDatabase,
    setPinnedDatabase,
    replaceExplorerDatabase,
  ]);
  const sessions = useAtomValue(sessionsAtom);
  const [debouncedFen] = useDebouncedValue(fen, 50);
  const lichessOptions = useAtomValue(lichessOptionsAtom);
  const masterOptions = useAtomValue(masterOptionsAtom);
  const setLocalOptions = useSetAtom(useTabAtom(localOptionsFamily));
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
      setLocalOptions((q) => (q.type === "exact" ? { ...q, fen: debouncedFen } : q));
    }
  }, [debouncedFen, setLocalOptions, db]);

  useEffect(() => {
    if (db === "local") {
      setLocalOptions((q) => ({ ...q, path: effectiveReferenceDatabase }));
    }
  }, [effectiveReferenceDatabase, setLocalOptions, db]);

  const {
    filters: localFilters,
    setFilters: setLocalFilters,
    options: effectiveLocalOptions,
  } = useExplorerFilters(effectiveReferenceDatabase);
  const dbType: DBType = match(db)
    .with("local", (v) => ({
      type: v,
      options: effectiveLocalOptions,
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
  const [storedView, setStoredView] = useAtom(useTabAtom(dbTabFamily));
  // A partial position has no move statistics. The view is derived, so the stored choice returns
  // with the exact position.
  const statsUnavailable = dbType.type === "local" && dbType.options.type === "partial";
  const view = statsUnavailable || storedView === "games" ? "games" : "stats";
  const localExplorer = useLocalExplorer(
    effectiveLocalOptions,
    db === "local",
    tab?.value || undefined,
  );
  const openingKey =
    !missingExplorerAuthentication && db !== "local"
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
  const errorMessage: string | undefined =
    db === "local"
      ? localExplorer.error
      : inlineFailureMessage(openingError, undefined, t("Board.Database.ExplorerLoadError"));

  const failedGames = openingData?.gameFailures
    ?.map(({ item }) => {
      const names = [item.white.name.trim(), item.black.name.trim()].filter(Boolean);
      return names.join(" - ") || item.id;
    })
    .join(", ");
  const hasGameFailures = (openingData?.gameFailures?.length ?? 0) > 0;

  const chooseDatabase = (value: string | null) => {
    // Clearing the native search cache only frees memory; the choice never depends on it.
    void Promise.resolve(tauri.clearGames()).catch(() => undefined);
    const nextDatabase = databaseHandleFromKey(readableDatabases, value);
    (pinnedDatabase ? setPinnedDatabase : setReferenceDatabase)(nextDatabase);
  };

  const loader = (
    <DatabaseLoader
      isLoading={isLoading}
      tab={db === "local" ? localExplorer.progressId : (tab?.value ?? null)}
    />
  );
  const sourceHeader = match(db)
    .with("local", () => (
      <ExplorerSourceHeader
        key={db}
        select={
          <Select
            data={dbSelectData}
            value={selectedReferenceDatabase}
            onChange={chooseDatabase}
            placeholder={t("Board.Database.SelectReference")}
            size="sm"
            flex={1}
            miw={0}
            maw={200}
            allowDeselect={false}
          />
        }
        filterLabel={localFilterSummary(localFilters, t)}
        filterDisabled={!effectiveReferenceDatabase}
        filters={
          <LocalFiltersForm
            database={effectiveReferenceDatabase}
            filters={localFilters}
            setFilters={setLocalFilters}
          />
        }
        loader={loader}
      />
    ))
    .with("lch_all", () => (
      <ExplorerSourceHeader
        key={db}
        filterLabel={t("Board.Database.Filters")}
        filters={<LichessOptionsPanel />}
        loader={loader}
      />
    ))
    .with("lch_master", () => (
      <ExplorerSourceHeader
        key={db}
        filterLabel={t("Board.Database.Filters")}
        filters={<MasterOptionsPanel />}
        loader={loader}
      />
    ))
    .exhaustive();

  /** What a view shows instead of its table while the source cannot answer. */
  const unavailable: ReactNode | null =
    db === "local" && !effectiveReferenceDatabase ? (
      <NoDatabaseWarning />
    ) : errorMessage !== undefined ? (
      <Alert color="danger">{errorMessage}</Alert>
    ) : missingExplorerAuthentication ? (
      <Alert color="warning">
        {t("Board.Database.ExplorerAuthRequired1")}{" "}
        <Link to="/accounts">{t("Home.Accounts.Users")}</Link>{" "}
        {t("Board.Database.ExplorerAuthRequired2")}
      </Alert>
    ) : null;

  return (
    <Tabs
      value={view}
      onChange={(v) => setStoredView(v!)}
      h="100%"
      px="sm"
      py="xs"
      display="flex"
      style={{ flexDirection: "column", overflow: "hidden" }}
    >
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Group gap="xs">
          <SegmentedControl
            data={[
              { label: t("Board.Database.Local"), value: "local" },
              { label: t("Board.Database.LichessAll"), value: "lch_all" },
              { label: t("Board.Database.LichessMaster"), value: "lch_master" },
            ]}
            value={db}
            onChange={(value) => setDb(value as "local" | "lch_all" | "lch_master")}
          />
          {db === "local" && <PositionSearchControl boardFen={debouncedFen} />}
        </Group>
        <Tabs.List style={{ flexWrap: "nowrap" }}>
          <Tabs.Tab value="stats" disabled={statsUnavailable}>
            {t("Board.Database.Stats")}
          </Tabs.Tab>
          <Tabs.Tab value="games">{t("Board.Database.Games")}</Tabs.Tab>
        </Tabs.List>
      </Group>
      <Group wrap="nowrap" align="flex-start" gap="sm" mt="xs">
        {sourceHeader}
      </Group>

      <ViewPanel value="stats">
        {unavailable ?? (
          <OpeningsTable openings={openingData?.openings || []} loading={isLoading} />
        )}
      </ViewPanel>
      <ViewPanel value="games">
        {unavailable ?? (
          <>
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
          </>
        )}
      </ViewPanel>
    </Tabs>
  );
}

function ViewPanel({ value, children }: { value: string; children: ReactNode }) {
  return (
    <Tabs.Panel
      pt="xs"
      value={value}
      flex={1}
      style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}
    >
      {children}
    </Tabs.Panel>
  );
}

export default memo(DatabasePanel);
