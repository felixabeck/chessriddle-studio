import { failureUnlessCancelled } from "@/platform/errors";
import { useTabAtom, useOwnerTab } from "@/state/tabScope";
import { tauri } from "@/platform/tauri";
import { Alert, Button, Group, Menu, SegmentedControl, Select, Stack, Tabs } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { Link } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Plus, X } from "lucide-react";
import { memo, type ReactNode, useCallback, useContext, useEffect } from "react";
import { useTranslation } from "react-i18next";
import useSWR from "swr/immutable";
import { useNativeRequestOwner } from "@/hooks/useNativeRequestOwner";
import { useDatabaseList } from "@/hooks/useDatabaseList";
import { match } from "ts-pattern";
import { useStore } from "zustand";
import { type DatabaseHandle, type NormalizedGame } from "@/bindings";
import { IconAction } from "@/components/common/IconAction";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { inlineFailureMessage } from "@/components/files/notifyError";
import {
  comparisonDbAtom,
  dbTabFamily,
  dbTypeFamily,
  explorerGamesSourceFamily,
  explorerSortFamily,
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
import classes from "./DatabasePanel.module.css";
import DatabaseLoader from "./DatabaseLoader";
import { comparisonState } from "./explorerComparison";
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

/** Follows a linked collection that publishes a new database in place of `selected`. */
function useCollectionDatabase(
  selected: DatabaseHandle | null,
  replaced: (from: DatabaseHandle, to: DatabaseHandle) => void,
) {
  const currency = useCollectionCurrency(selected);
  const current = currency.collection?.database;
  useEffect(() => {
    if (current && selected && databaseHandleKey(current) !== databaseHandleKey(selected)) {
      replaced(selected, current);
    }
  }, [current, selected, replaced]);
  return currency;
}

function DatabasePanel() {
  const { t } = useTranslation();

  const store = useContext(TreeStateContext)!;
  const fen = useStore(store, (s) => s.currentNode().fen);
  const [referenceDatabase, setReferenceDatabase] = useAtom(referenceDbAtom);
  const [pinnedDatabase, setPinnedDatabase] = useAtom(useTabAtom(pinnedExplorerDatabaseFamily));
  const selectedDatabase = pinnedDatabase ?? referenceDatabase;
  const replaceExplorerDatabase = useSetAtom(replaceExplorerDatabaseAtom);
  const pinned = pinnedDatabase !== null;
  const replaceStored = useCallback(
    (from: DatabaseHandle, to: DatabaseHandle) => replaceExplorerDatabase({ from, to }),
    [replaceExplorerDatabase],
  );
  // A pin is the tab's own choice; every other choice is stored and follows the replacement.
  const replacePrimary = useCallback(
    (from: DatabaseHandle, to: DatabaseHandle) =>
      pinned ? setPinnedDatabase(to) : replaceExplorerDatabase({ from, to }),
    [pinned, setPinnedDatabase, replaceExplorerDatabase],
  );
  const currency = useCollectionDatabase(selectedDatabase, replacePrimary);
  const [storedComparison, setStoredComparison] = useAtom(comparisonDbAtom);
  const sessions = useAtomValue(sessionsAtom);
  const [debouncedFen] = useDebouncedValue(fen, 50);
  const lichessOptions = useAtomValue(lichessOptionsAtom);
  const masterOptions = useAtomValue(masterOptionsAtom);
  const setLocalOptions = useSetAtom(useTabAtom(localOptionsFamily));
  const [db, setDb] = useAtom(useTabAtom(dbTypeFamily));
  const explorerHandle = sessions.find((session) => session.lichess?.handle)?.lichess?.handle;
  const missingExplorerAuthentication = db !== "local" && !explorerHandle;

  const { data: databases, error: databasesError } = useDatabaseList(db === "local");

  const readableDatabases = failureUnlessCancelled(databasesError)
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

  const comparison = comparisonState({
    local: db === "local",
    pinned,
    primary: effectiveReferenceDatabase,
    stored: storedComparison,
    databases: databasesError ? undefined : databases?.databases,
  });
  const comparisonDatabase = comparison.kind === "source" ? comparison.database : null;
  // The stored choice is followed, not the shown one: a database its collection already replaced
  // is no longer in the list, and only its collection still knows the successor.
  useCollectionDatabase(db === "local" && !pinned ? storedComparison : null, replaceStored);
  const comparisonFilters = useExplorerFilters(comparisonDatabase);
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
  // Its own progress id: a job on the primary's id would supersede the primary's progress.
  const comparisonExplorer = useLocalExplorer(
    comparisonFilters.options,
    db === "local" && comparisonDatabase !== null,
    tab?.value ? `${tab.value}:comparison` : undefined,
  );
  const [storedGamesSource, setGamesSource] = useAtom(useTabAtom(explorerGamesSourceFamily));
  const gamesSource =
    comparisonDatabase && storedGamesSource === "comparison" ? "comparison" : "primary";
  const [sort, setSort] = useAtom(useTabAtom(explorerSortFamily));
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

  // Clearing the native search cache only frees memory; a choice never depends on it.
  const clearSearchCache = () => void Promise.resolve(tauri.clearGames()).catch(() => undefined);
  const choose = (store: (database: DatabaseHandle | null) => void) => (value: string | null) => {
    clearSearchCache();
    store(databaseHandleFromKey(readableDatabases, value));
  };
  const chooseDatabase = choose(pinnedDatabase ? setPinnedDatabase : setReferenceDatabase);
  const chooseComparison = choose(setStoredComparison);
  const comparisonChoices = dbSelectData.filter(
    (choice) => choice.value !== selectedReferenceDatabase,
  );
  const primaryTitle =
    dbSelectData.find((choice) => choice.value === selectedReferenceDatabase)?.label ?? "";
  const canCompare =
    db === "local" &&
    !pinned &&
    !!effectiveReferenceDatabase &&
    comparison.kind === "none" &&
    comparisonChoices.length > 0;

  /** A local source's cell: the two differ only in their database, filters and progress. */
  const localSourceHeader = (source: {
    key: string;
    choices: typeof dbSelectData;
    database: DatabaseHandle | null;
    choose: (value: string | null) => void;
    name?: string;
    binding: Pick<ReturnType<typeof useExplorerFilters>, "filters" | "setFilters">;
    explorer: Pick<ReturnType<typeof useLocalExplorer>, "loading" | "progressId">;
    action?: ReactNode;
  }) => (
    <ExplorerSourceHeader
      key={source.key}
      select={
        <Select
          data={source.choices}
          value={source.database ? databaseHandleKey(source.database) : null}
          onChange={source.choose}
          placeholder={source.name ? undefined : t("Board.Database.SelectReference")}
          aria-label={source.name}
          size="sm"
          flex={1}
          miw={0}
          allowDeselect={false}
        />
      }
      filterLabel={localFilterSummary(source.binding.filters, t)}
      filterDisabled={!source.database}
      filters={
        <LocalFiltersForm
          database={source.database}
          filters={source.binding.filters}
          setFilters={source.binding.setFilters}
        />
      }
      action={source.action}
      loader={
        <DatabaseLoader isLoading={source.explorer.loading} tab={source.explorer.progressId} />
      }
    />
  );
  const onlineLoader = <DatabaseLoader isLoading={isLoading} tab={tab?.value ?? null} />;
  const sourceHeader = match(db)
    .with("local", () =>
      localSourceHeader({
        key: db,
        choices: dbSelectData,
        database: effectiveReferenceDatabase,
        choose: chooseDatabase,
        binding: { filters: localFilters, setFilters: setLocalFilters },
        explorer: localExplorer,
      }),
    )
    .with("lch_all", () => (
      <ExplorerSourceHeader
        key={db}
        filterLabel={t("Board.Database.Filters")}
        filters={<LichessOptionsPanel />}
        loader={onlineLoader}
      />
    ))
    .with("lch_master", () => (
      <ExplorerSourceHeader
        key={db}
        filterLabel={t("Board.Database.Filters")}
        filters={<MasterOptionsPanel />}
        loader={onlineLoader}
      />
    ))
    .exhaustive();
  const comparisonHeader =
    comparison.kind === "source" &&
    localSourceHeader({
      key: "comparison",
      choices: comparisonChoices,
      database: comparison.database,
      choose: chooseComparison,
      name: t("Board.Database.CompareWith"),
      binding: comparisonFilters,
      explorer: comparisonExplorer,
      action: (
        <IconAction
          label={t("Board.Database.RemoveComparison")}
          variant="subtle"
          size="sm"
          onClick={() => setStoredComparison(null)}
        >
          <X size="0.875rem" />
        </IconAction>
      ),
    });

  // With two sources a failure belongs to its source: it is named, and the other one stays.
  const twoSources =
    comparison.kind === "source"
      ? ([
          { role: "primary", name: primaryTitle, explorer: localExplorer },
          { role: "comparison", name: comparison.title, explorer: comparisonExplorer },
        ] as const)
      : null;
  const sourceAlert = (source: NonNullable<typeof twoSources>[number]) => (
    <Alert key={source.role} color="danger" style={{ flexShrink: 0 }}>
      {`${source.name}: ${source.explorer.error}`}
    </Alert>
  );
  const failedSources = twoSources?.filter((source) => source.explorer.error !== undefined) ?? [];
  const gamesFrom = twoSources?.find((source) => source.role === gamesSource);

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
          {canCompare && (
            <Menu position="bottom-start" withinPortal>
              <Menu.Target>
                <Button
                  variant="subtle"
                  size="compact-sm"
                  leftSection={<Plus size="0.875rem" />}
                  aria-label={t("Board.Database.CompareWith")}
                >
                  {t("Board.Database.Compare")}
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                {comparisonChoices.map((choice) => (
                  <Menu.Item key={choice.value} onClick={() => chooseComparison(choice.value)}>
                    {choice.label}
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>
          )}
        </Group>
        <Tabs.List style={{ flexWrap: "nowrap" }}>
          <Tabs.Tab value="stats" disabled={statsUnavailable}>
            {t("Board.Database.Stats")}
          </Tabs.Tab>
          <Tabs.Tab value="games">{t("Board.Database.Games")}</Tabs.Tab>
        </Tabs.List>
      </Group>
      <div className={classes.sources} data-two-sources={twoSources ? true : undefined}>
        {sourceHeader}
        {comparisonHeader}
      </div>
      {comparison.kind === "unreadable" && (
        <Alert
          color="warning"
          mt="xs"
          style={{ flexShrink: 0 }}
          withCloseButton
          closeButtonLabel={t("Board.Database.RemoveComparison")}
          onClose={() => setStoredComparison(null)}
        >
          {t("Board.Database.ComparisonUnreadable", { database: comparison.name })}
        </Alert>
      )}

      <ViewPanel value="stats">
        {twoSources ? (
          <>
            {failedSources.map(sourceAlert)}
            {failedSources.length < twoSources.length && (
              <OpeningsTable
                openings={localExplorer.openings}
                loading={localExplorer.loading}
                comparison={{
                  openings: comparisonExplorer.openings,
                  loading: comparisonExplorer.loading,
                }}
                sort={sort}
                onSortChange={setSort}
              />
            )}
          </>
        ) : (
          (unavailable ?? (
            <OpeningsTable openings={openingData?.openings || []} loading={isLoading} />
          ))
        )}
      </ViewPanel>
      <ViewPanel value="games">
        {twoSources && gamesFrom ? (
          <Stack gap="xs" flex={1} style={{ overflow: "hidden" }}>
            <SegmentedControl
              aria-label={t("Board.Database.GamesSource")}
              style={{ flexShrink: 0, alignSelf: "flex-start" }}
              size="xs"
              data={twoSources.map((source) => ({ value: source.role, label: source.name }))}
              value={gamesSource}
              onChange={(value) => setGamesSource(value as typeof gamesSource)}
            />
            {gamesFrom.explorer.error !== undefined ? (
              sourceAlert(gamesFrom)
            ) : (
              <GamesTable
                games={gamesFrom.explorer.games}
                loading={gamesFrom.explorer.loading}
                databasePath={
                  gamesFrom.role === "comparison" ? comparisonDatabase : effectiveReferenceDatabase
                }
              />
            )}
          </Stack>
        ) : (
          (unavailable ?? (
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
          ))
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
