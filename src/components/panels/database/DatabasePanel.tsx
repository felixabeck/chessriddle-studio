import { useTabAtom, useOwnerTab } from "@/state/tabScope";
import { tauri } from "@/platform/tauri";
import {
  Alert,
  Box,
  Button,
  Flex,
  Group,
  Menu,
  SegmentedControl,
  Select,
  Stack,
  Tabs,
  Text,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { Link } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Pin, PinOff, Plus, Settings, X } from "lucide-react";
import { memo, type ReactNode, useCallback, useContext, useEffect } from "react";
import { useTranslation } from "react-i18next";
import useSWR from "swr/immutable";
import { useNativeRequestOwner } from "@/hooks/useNativeRequestOwner";
import { useDatabaseList } from "@/hooks/useDatabaseList";
import { match } from "ts-pattern";
import { useStore } from "zustand";
import type { DatabaseHandle, NormalizedGame } from "@/bindings";
import { IconAction } from "@/components/common/IconAction";
import { PinnedPlacementItems } from "@/components/boards/PinnedPlacementItems";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { inlineFailureMessage } from "@/components/files/notifyError";
import {
  comparisonDbAtom,
  dbTabFamily,
  dbTypeFamily,
  explorerGamesSourceFamily,
  explorerDetachedAtom,
  explorerPlacementAtom,
  explorerHeaderCollapsedAtom,
  explorerSortFamily,
  type ExplorerSourceRole,
  localOptionsFamily,
  pinnedExplorerComparisonFamily,
  pinnedExplorerDatabaseFamily,
  pinnedExplorerReferenceFamily,
  lichessOptionsAtom,
  masterOptionsAtom,
  referenceDbAtom,
  replaceExplorerDatabaseAtom,
  sessionsAtom,
  tabFamily,
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
import { comparisonState, pinnedReferenceState } from "./explorerComparison";
import ExplorerSourceHeader, { ExplorerSourceCaption } from "./ExplorerSourceHeader";
import { lichessFiltersActive, localFilterSummary, masterFiltersActive } from "./filterSummary";
import GamesTable from "./GamesTable";
import NoDatabaseWarning from "./NoDatabaseWarning";
import OpeningsTable from "./OpeningsTable";
import LichessOptionsPanel from "./options/LichessOptionsPanel";
import LocalFiltersForm from "./options/LocalFiltersForm";
import { type ExplorerFilters, isDefaultExplorerFilters } from "@/state/explorerFilters";
import { useCollectionCurrency } from "@/state/linkedCollections";
import { failureUnlessCancelled } from "@/platform/errors";
import MasterOptionsPanel from "./options/MastersOptionsPanel";
import PositionSearchControl from "./PositionSearchControl";
import { useExplorerFilters } from "./useExplorerFilters";
import { usePlayerName } from "./usePlayerName";
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
  /**
   * Every game that reached the position, when the source reports it apart from its move rows.
   * The online explorers list only their most common continuations and no row for games that
   * ended in the position, so their move rows undercount it.
   */
  total?: Opening;
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
    total: { move: "", white: data.white, black: data.black, draw: data.draws },
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

/** The height of the sources' size "sm" select, so a titled source lines up with a selectable one. */
const SOURCE_SELECT_HEIGHT = 36;

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
  // A pinned tab's second column is the tab's own; the app-wide choice is not its concern.
  const [pinnedComparison, setPinnedComparison] = useAtom(
    useTabAtom(pinnedExplorerComparisonFamily),
  );
  const [showPinnedReference, setShowPinnedReference] = useAtom(
    useTabAtom(pinnedExplorerReferenceFamily),
  );
  const removeComparison = () => (pinned ? setPinnedComparison(null) : setStoredComparison(null));
  const sessions = useAtomValue(sessionsAtom);
  const [debouncedFen] = useDebouncedValue(fen, 50);
  const lichessOptions = useAtomValue(lichessOptionsAtom);
  const masterOptions = useAtomValue(masterOptionsAtom);
  const setLocalOptions = useSetAtom(useTabAtom(localOptionsFamily));
  const [db, setDb] = useAtom(useTabAtom(dbTypeFamily));
  const explorerHandle = sessions.find((session) => session.lichess?.handle)?.lichess?.handle;
  const missingExplorerAuthentication = db !== "local" && !explorerHandle;

  const { data: databases, error: databasesError } = useDatabaseList(db === "local");

  const databasesFailure = failureUnlessCancelled(databasesError);
  const readableDatabases = databasesFailure
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
    pinnedComparison: pinnedComparison?.database ?? null,
    databases: databasesFailure ? undefined : databases?.databases,
  });
  const comparisonDatabase = comparison.kind === "source" ? comparison.database : null;
  // The pinned second column searches for its own player and shares the tab's other filters.
  const comparisonPlayer = pinned ? (pinnedComparison?.player ?? null) : null;
  // The stored choice is followed, not the shown one: a database its collection already replaced
  // is no longer in the list, and only its collection still knows the successor.
  useCollectionDatabase(db === "local" && !pinned ? storedComparison : null, replaceStored);
  useCollectionDatabase(db === "local" && pinned ? referenceDatabase : null, replaceStored);
  const comparisonFilters = useExplorerFilters(comparisonDatabase, comparisonPlayer);
  const availableReference = pinnedReferenceState({
    local: db === "local",
    pinned,
    primary: effectiveReferenceDatabase,
    reference: referenceDatabase,
    databases: databasesFailure ? undefined : databases?.databases,
  });
  const referenceSource = showPinnedReference ? availableReference : { kind: "none" as const };
  const pinnedReferenceDatabase =
    referenceSource.kind === "source" ? referenceSource.database : null;
  const pinnedReferenceFilters = useExplorerFilters(pinnedReferenceDatabase, null, { saved: true });
  // A player filter is named in each header, so a board says whose games it shows.
  const primaryPlayerName = usePlayerName(effectiveReferenceDatabase, localFilters.player);
  const comparisonPlayerName = usePlayerName(comparisonDatabase, comparisonFilters.filters.player);
  const pinnedReferencePlayerName = usePlayerName(
    pinnedReferenceDatabase,
    pinnedReferenceFilters.filters.player,
  );
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
  // A partial search is a pattern, not one position, so its games open at the start.
  const gamesTargetFen = statsUnavailable ? undefined : debouncedFen;
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
  const pinnedReferenceExplorer = useLocalExplorer(
    pinnedReferenceFilters.options,
    db === "local" && pinnedReferenceDatabase !== null,
    tab?.value ? `${tab.value}:reference` : undefined,
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
  const canRestoreReference =
    db === "local" && pinned && !showPinnedReference && availableReference.kind === "source";

  /** A local source's cell: each source differs only in its database, title, and filter binding. */
  const localSourceHeader = (source: {
    key: string;
    choices: typeof dbSelectData;
    database: DatabaseHandle | null;
    choose: (value: string | null) => void;
    name?: string;
    /** A source that cannot be exchanged shows this title instead of the select. */
    fixedTitle?: string;
    fixedPlayer?: boolean;
    binding: Pick<ReturnType<typeof useExplorerFilters>, "filters" | "setFilters">;
    playerName: string | undefined;
    action?: ReactNode;
  }) => (
    <ExplorerSourceHeader
      key={source.key}
      select={
        source.fixedTitle !== undefined ? (
          <Flex align="center" flex={1} miw={0} h={SOURCE_SELECT_HEIGHT}>
            <Text fz="sm" fw={600} truncate title={source.fixedTitle}>
              {source.fixedTitle}
            </Text>
          </Flex>
        ) : (
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
        )
      }
      filterLabel={localFilterSummary(source.binding.filters, t, source.playerName)}
      filterDisabled={!source.database}
      filters={
        <LocalFiltersForm
          database={source.database}
          filters={source.binding.filters}
          setFilters={source.binding.setFilters}
          fixedPlayer={source.fixedPlayer}
        />
      }
      action={source.action}
    />
  );
  const sourceHeader = match(db)
    .with("local", () =>
      localSourceHeader({
        key: db,
        choices: dbSelectData,
        database: effectiveReferenceDatabase,
        choose: chooseDatabase,
        binding: { filters: localFilters, setFilters: setLocalFilters },
        playerName: primaryPlayerName,
      }),
    )
    .with("lch_all", () => (
      <ExplorerSourceHeader
        key={db}
        filterLabel={t("Board.Database.Filters")}
        filters={<LichessOptionsPanel />}
      />
    ))
    .with("lch_master", () => (
      <ExplorerSourceHeader
        key={db}
        filterLabel={t("Board.Database.Filters")}
        filters={<MasterOptionsPanel />}
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
      ...(pinned ? { fixedTitle: comparison.title, fixedPlayer: comparisonPlayer !== null } : {}),
      binding: comparisonFilters,
      playerName: comparisonPlayerName,
      action: (
        <IconAction
          label={t("Board.Database.RemoveComparison")}
          variant="subtle"
          size="sm"
          onClick={removeComparison}
        >
          <X size="0.875rem" />
        </IconAction>
      ),
    });
  const pinnedReferenceHeader =
    referenceSource.kind === "source" &&
    localSourceHeader({
      key: "reference",
      choices: [],
      database: referenceSource.database,
      choose: () => undefined,
      fixedTitle: referenceSource.title,
      binding: pinnedReferenceFilters,
      playerName: pinnedReferencePlayerName,
      action: (
        <IconAction
          label={t("Board.Database.RemoveReference")}
          variant="subtle"
          size="sm"
          onClick={() => setShowPinnedReference(false)}
        >
          <X size="0.875rem" />
        </IconAction>
      ),
    });

  const [storedCollapsed, setStoredCollapsed] = useAtom(explorerHeaderCollapsedAtom);
  // The panel asks for a database through its select, so the controls stay open until the list
  // has answered with one. The stored preference is left as it is.
  const needsDatabase =
    db === "local" &&
    !effectiveReferenceDatabase &&
    (databases !== undefined || databasesFailure !== undefined);
  const collapsed = storedCollapsed && !needsDatabase;
  // Collapsed, each source still names whatever narrows its numbers.
  const partialPosition =
    effectiveLocalOptions.type === "partial"
      ? t("Board.Database.PositionMode", { mode: t("Board.Database.Local.Partial") })
      : null;
  const localCaption = (source: {
    key: string;
    name: string;
    filters: ExplorerFilters;
    playerName: string | undefined;
  }) => (
    <ExplorerSourceCaption
      key={source.key}
      name={source.name}
      detail={[
        isDefaultExplorerFilters(source.filters)
          ? null
          : localFilterSummary(source.filters, t, source.playerName),
        partialPosition,
      ]
        .filter((part) => part !== null)
        .join(" · ")}
    />
  );
  const onlineCaption = (name: string, filtered: boolean) => (
    <ExplorerSourceCaption
      key={db}
      name={name}
      detail={filtered ? t("Board.Database.Filters") : undefined}
    />
  );
  const sourceCaptions = match(db)
    .with("local", () => [
      localCaption({
        key: db,
        name: primaryTitle,
        filters: localFilters,
        playerName: primaryPlayerName,
      }),
      comparison.kind === "source" &&
        localCaption({
          key: "comparison",
          name: comparison.title,
          filters: comparisonFilters.filters,
          playerName: comparisonPlayerName,
        }),
      referenceSource.kind === "source" &&
        localCaption({
          key: "reference",
          name: referenceSource.title,
          filters: pinnedReferenceFilters.filters,
          playerName: pinnedReferencePlayerName,
        }),
    ])
    .with("lch_all", () =>
      onlineCaption(t("Board.Database.LichessAll"), lichessFiltersActive(lichessOptions)),
    )
    .with("lch_master", () =>
      onlineCaption(t("Board.Database.LichessMaster"), masterFiltersActive(masterOptions)),
    )
    .exhaustive();
  const [detached, setDetached] = useAtom(explorerDetachedAtom);
  const [placement, setPlacement] = useAtom(explorerPlacementAtom);
  const setBoardPanel = useSetAtom(useTabAtom(tabFamily));
  const headerActions = (
    <>
      <IconAction
        label={collapsed ? t("Board.Database.ShowSettings") : t("Board.Database.HideSettings")}
        variant="subtle"
        size="sm"
        pressed={!collapsed}
        disabled={needsDatabase}
        onClick={() => setStoredCollapsed(!storedCollapsed)}
      >
        <Settings size="0.875rem" />
      </IconAction>
      {/* One menu pins the panel to a place, moves it, or unpins it. */}
      <Menu position="bottom-end" shadow="md" withinPortal>
        <Menu.Target>
          <IconAction
            label={detached ? t("Board.Database.Position") : t("Board.Database.Pin")}
            variant="subtle"
            size="sm"
            pressed={detached}
          >
            <Pin size="0.875rem" />
          </IconAction>
        </Menu.Target>
        <Menu.Dropdown>
          <PinnedPlacementItems
            current={detached ? placement : null}
            onChoose={(next) => {
              setPlacement(next);
              setDetached(true);
            }}
          />
          {detached && (
            <>
              <Menu.Divider />
              <Menu.Item
                leftSection={<PinOff size="0.875rem" />}
                onClick={() => {
                  // Unpinned, the panel goes back to being a tab, and that tab is the one shown.
                  setBoardPanel("database");
                  setDetached(false);
                }}
              >
                {t("Board.Database.Unpin")}
              </Menu.Item>
            </>
          )}
        </Menu.Dropdown>
      </Menu>
    </>
  );

  // With multiple sources a failure belongs to its source: it is named, and the others stay.
  type LocalSourceEntry = {
    role: ExplorerSourceRole;
    name: string;
    explorer: typeof localExplorer;
  };
  const extraStatsSources: LocalSourceEntry[] = [
    ...(comparison.kind === "source"
      ? [{ role: "comparison" as const, name: comparison.title, explorer: comparisonExplorer }]
      : []),
    ...(referenceSource.kind === "source"
      ? [
          {
            role: "reference" as const,
            name: referenceSource.title,
            explorer: pinnedReferenceExplorer,
          },
        ]
      : []),
  ];
  const statsSources: LocalSourceEntry[] | null =
    extraStatsSources.length > 0
      ? [{ role: "primary", name: primaryTitle, explorer: localExplorer }, ...extraStatsSources]
      : null;
  const sourceAlert = (source: LocalSourceEntry) => (
    <Alert key={source.role} color="danger" style={{ flexShrink: 0 }}>
      {`${source.name}: ${source.explorer.error}`}
    </Alert>
  );
  const failedSources = statsSources?.filter((source) => source.explorer.error !== undefined) ?? [];
  // The games view keeps the primary and optional comparison source; the reference source adds
  // no games list and no entry to that switch.
  const gamesSources =
    comparison.kind === "source"
      ? ([
          { role: "primary", name: primaryTitle, explorer: localExplorer },
          { role: "comparison", name: comparison.title, explorer: comparisonExplorer },
        ] as const)
      : null;
  const gamesFrom = gamesSources?.find((source) => source.role === gamesSource);

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
      {collapsed ? (
        <div className={classes.captions}>
          <div
            className={classes.sources}
            data-sources={statsSources ? String(statsSources.length) : undefined}
            data-collapsed
          >
            {sourceCaptions}
          </div>
          <Group gap={4} wrap="nowrap" className={classes.actions}>
            {headerActions}
          </Group>
        </div>
      ) : (
        <>
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
              {canRestoreReference && (
                <Button
                  variant="subtle"
                  size="compact-sm"
                  leftSection={<Plus size="0.875rem" />}
                  onClick={() => setShowPinnedReference(true)}
                >
                  {t("Board.Database.ShowReference")}
                </Button>
              )}
            </Group>
            <Group gap={4} wrap="nowrap">
              <Tabs.List style={{ flexWrap: "nowrap" }}>
                <Tabs.Tab value="stats" disabled={statsUnavailable}>
                  {t("Board.Database.Stats")}
                </Tabs.Tab>
                <Tabs.Tab value="games">{t("Board.Database.Games")}</Tabs.Tab>
              </Tabs.List>
              {headerActions}
            </Group>
          </Group>
          <div
            className={classes.sources}
            data-sources={statsSources ? String(statsSources.length) : undefined}
          >
            {sourceHeader}
            {comparisonHeader}
            {pinnedReferenceHeader}
          </div>
        </>
      )}
      {comparison.kind === "unreadable" && (
        <Alert
          color="warning"
          mt="xs"
          style={{ flexShrink: 0 }}
          withCloseButton
          closeButtonLabel={t("Board.Database.RemoveComparison")}
          onClose={removeComparison}
        >
          {t("Board.Database.ComparisonUnreadable", { database: comparison.name })}
        </Alert>
      )}

      <ViewPanel value="stats" view={view} plain={collapsed}>
        {statsSources ? (
          <>
            {failedSources.map(sourceAlert)}
            {failedSources.length < statsSources.length && (
              <OpeningsTable
                openings={localExplorer.openings}
                loading={localExplorer.loading}
                sources={statsSources.map(({ role, explorer }) => ({
                  role,
                  openings: explorer.openings,
                  loading: explorer.loading,
                }))}
                sort={sort}
                onSortChange={setSort}
              />
            )}
          </>
        ) : (
          (unavailable ?? (
            <OpeningsTable
              openings={openingData?.openings || []}
              total={openingData?.total}
              loading={isLoading}
            />
          ))
        )}
      </ViewPanel>
      <ViewPanel value="games" view={view} plain={collapsed}>
        {gamesSources && gamesFrom ? (
          <Stack gap="xs" flex={1} style={{ overflow: "hidden" }}>
            <SegmentedControl
              aria-label={t("Board.Database.GamesSource")}
              style={{ flexShrink: 0, alignSelf: "flex-start" }}
              size="xs"
              data={gamesSources.map((source) => ({ value: source.role, label: source.name }))}
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
                targetFen={gamesTargetFen}
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
                  targetFen={gamesTargetFen}
                />
              )}
            </>
          ))
        )}
      </ViewPanel>
    </Tabs>
  );
}

/**
 * One of the two views. Collapsed, the header shows no view switch, so the view is a plain
 * region instead of a tab panel naming a tab that is not there.
 */
function ViewPanel({
  value,
  view,
  plain,
  children,
}: {
  value: string;
  view: string;
  plain: boolean;
  children: ReactNode;
}) {
  const layout = { display: "flex", flexDirection: "column", overflow: "hidden" } as const;
  if (plain) {
    return value === view ? (
      <Box pt="xs" flex={1} style={layout}>
        {children}
      </Box>
    ) : null;
  }
  return (
    <Tabs.Panel pt="xs" value={value} flex={1} style={layout}>
      {children}
    </Tabs.Panel>
  );
}

export default memo(DatabasePanel);
