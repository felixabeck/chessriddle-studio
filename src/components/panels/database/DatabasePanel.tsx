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
import { useDatabaseList } from "@/hooks/useDatabaseList";
import { useStore } from "zustand";
import type { DatabaseHandle, NormalizedGame } from "@/bindings";
import { IconAction } from "@/components/common/IconAction";
import { PinnedPlacementItems } from "@/components/boards/PinnedPlacementItems";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import {
  comparisonDbAtom,
  dbTabFamily,
  dbTypeFamily,
  explorerGamesSourceFamily,
  explorerDetachedAtom,
  explorerPlacementAtom,
  explorerHeaderCollapsedAtom,
  explorerSortFamily,
  type ExplorerColumnId,
  type ExplorerFurtherColumn,
  type ExplorerGamesSourceRole,
  type ExplorerOnlineSource,
  isDatabaseComparisonSource,
  localOptionsFamily,
  pinnedExplorerComparisonFamily,
  pinnedExplorerDatabaseFamily,
  pinnedExplorerFurtherColumnsFamily,
  lichessOptionsAtom,
  masterOptionsAtom,
  referenceDbAtom,
  replaceExplorerDatabaseAtom,
  sessionsAtom,
  tabFamily,
} from "@/state/atoms";
import { databaseHandleFromKey, databaseHandleKey, type Opening } from "@/utils/db";
import classes from "./DatabasePanel.module.css";
import {
  addFurtherColumn,
  comparisonState,
  furtherColumnChoices,
  pinnedReferenceState,
  shownFurtherColumns,
} from "./explorerComparison";
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
import { useLocalExplorer } from "./useLocalExplorer";
import { type OnlineExplorerResult, useOnlineExplorer } from "./useOnlineExplorer";

export type { LocalOptions } from "@/utils/db";

type OpeningData = {
  openings: Opening[];
  /**
   * Every game that reached the position, when the source reports it apart from its move rows.
   * The online explorers list only their most common continuations and no row for games that
   * ended in the position, so their move rows undercount it.
   */
  total?: Opening;
  games: NormalizedGame[];
  gameFailures?: OnlineExplorerResult["gameFailures"];
};

type SelectItem = { value: string; label: string };
type SelectGroup = { group: string; items: SelectItem[] };

const ONLINE_SOURCES: readonly ExplorerOnlineSource[] = ["lch_all", "lch_master"];

function isOnlineSource(value: string | null): value is ExplorerOnlineSource {
  return value === "lch_all" || value === "lch_master";
}

/** The height of the sources' size "sm" select, so a titled source lines up with a selectable one. */
const SOURCE_SELECT_HEIGHT = 36;
/**
 * The cap on the open source list: room for a handful of databases plus the two Lichess sources
 * below them, which Mantine's 220 px default cut off; a longer list still scrolls.
 */
const SOURCE_LIST_MAX_HEIGHT = 420;

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

function failedGameLabels(failures: OnlineExplorerResult["gameFailures"]): string {
  return (
    failures
      ?.map(({ item }) => {
        const names = [item.white.name.trim(), item.black.name.trim()].filter(Boolean);
        return names.join(" - ") || item.id;
      })
      .join(", ") ?? ""
  );
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
  useCollectionDatabase(selectedDatabase, replacePrimary);
  const [storedComparison, setStoredComparison] = useAtom(comparisonDbAtom);
  // A pinned tab's second column is the tab's own; the app-wide choice is not its concern.
  const [pinnedComparison, setPinnedComparison] = useAtom(
    useTabAtom(pinnedExplorerComparisonFamily),
  );
  const [furtherColumns, setFurtherColumns] = useAtom(
    useTabAtom(pinnedExplorerFurtherColumnsFamily),
  );
  const removeComparison = () => (pinned ? setPinnedComparison(null) : setStoredComparison(null));
  const sessions = useAtomValue(sessionsAtom);
  const [debouncedFen] = useDebouncedValue(fen, 50);
  const lichessOptions = useAtomValue(lichessOptionsAtom);
  const masterOptions = useAtomValue(masterOptionsAtom);
  const setLocalOptions = useSetAtom(useTabAtom(localOptionsFamily));
  const [firstSource, setFirstSource] = useAtom(useTabAtom(dbTypeFamily));
  const explorerHandle = sessions.find((session) => session.lichess?.handle)?.lichess?.handle;

  const { data: databases, error: databasesError } = useDatabaseList();

  const databasesFailure = failureUnlessCancelled(databasesError);
  const readableDatabases = databasesFailure
    ? []
    : (databases?.databases ?? []).filter((d) => d.type === "success");
  const listedDatabases = databasesFailure ? undefined : databases?.databases;
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

  const comparison = comparisonState({
    first: firstSource,
    pinned,
    primary: effectiveReferenceDatabase,
    stored: storedComparison,
    pinnedComparison: pinnedComparison?.database ?? null,
    databases: listedDatabases,
  });
  const comparisonDatabase = comparison.kind === "database" ? comparison.database : null;
  const comparisonShown = comparison.kind === "database" || comparison.kind === "online";
  const availableReference = pinnedReferenceState({
    pinned,
    primary: effectiveReferenceDatabase,
    reference: referenceDatabase,
    databases: listedDatabases,
  });
  const furtherContext = {
    pinned,
    primary: effectiveReferenceDatabase,
    comparisonShown,
    reference: referenceDatabase,
    databases: listedDatabases,
  };
  const furtherShown = shownFurtherColumns({
    columns: furtherColumns,
    ...furtherContext,
  });
  const furtherChoices = furtherColumnChoices(furtherColumns, furtherContext);
  const referenceFurther = furtherShown.find((column) => column.id === "reference");
  const showingLocalSource =
    firstSource === "local" ||
    comparison.kind === "database" ||
    furtherShown.some((column) => column.id === "reference");

  useEffect(() => {
    if (showingLocalSource) {
      setLocalOptions((q) => (q.type === "exact" ? { ...q, fen: debouncedFen } : q));
    }
  }, [debouncedFen, setLocalOptions, showingLocalSource]);

  useEffect(() => {
    if (showingLocalSource) {
      setLocalOptions((q) => ({ ...q, path: effectiveReferenceDatabase }));
    }
  }, [effectiveReferenceDatabase, setLocalOptions, showingLocalSource]);

  const {
    filters: localFilters,
    setFilters: setLocalFilters,
    options: effectiveLocalOptions,
  } = useExplorerFilters(effectiveReferenceDatabase);

  // The pinned second column searches for its own player and shares the tab's other filters.
  const comparisonPlayer = pinned ? (pinnedComparison?.player ?? null) : null;
  // The stored choice is followed, not the shown one: a database its collection already replaced
  // is no longer in the list, and only its collection still knows the successor.
  useCollectionDatabase(
    !pinned && isDatabaseComparisonSource(storedComparison) ? storedComparison : null,
    replaceStored,
  );
  useCollectionDatabase(pinned ? referenceDatabase : null, replaceStored);
  const comparisonFilters = useExplorerFilters(comparisonDatabase, comparisonPlayer);
  const pinnedReferenceDatabase = referenceFurther?.database ?? null;
  const pinnedReferenceFilters = useExplorerFilters(pinnedReferenceDatabase, null, { saved: true });
  // A player filter is named in each header, so a board says whose games it shows.
  const primaryPlayerName = usePlayerName(effectiveReferenceDatabase, localFilters.player);
  const comparisonPlayerName = usePlayerName(comparisonDatabase, comparisonFilters.filters.player);
  const pinnedReferencePlayerName = usePlayerName(
    pinnedReferenceDatabase,
    pinnedReferenceFilters.filters.player,
  );
  const [tab] = useOwnerTab();
  const [storedView, setStoredView] = useAtom(useTabAtom(dbTabFamily));
  // A partial position has no move statistics. The view is derived, so the stored choice returns
  // with the exact position. A Lichess-only panel ignores the partial setting.
  const statsUnavailable = showingLocalSource && effectiveLocalOptions.type === "partial";
  const view = statsUnavailable || storedView === "games" ? "games" : "stats";
  // A partial search is a pattern, not one position, so its games open at the start.
  const gamesTargetFen = statsUnavailable ? undefined : debouncedFen;
  const localExplorer = useLocalExplorer(
    effectiveLocalOptions,
    firstSource === "local" && effectiveReferenceDatabase !== null,
    tab?.value || undefined,
  );
  // Its own progress id: a job on the primary's id would supersede the primary's progress.
  const comparisonExplorer = useLocalExplorer(
    comparisonFilters.options,
    comparison.kind === "database",
    tab?.value ? `${tab.value}:comparison` : undefined,
  );
  const pinnedReferenceExplorer = useLocalExplorer(
    pinnedReferenceFilters.options,
    referenceFurther !== undefined,
    tab?.value ? `${tab.value}:reference` : undefined,
  );
  const [storedGamesSource, setGamesSource] = useAtom(useTabAtom(explorerGamesSourceFamily));
  const [sort, setSort] = useAtom(useTabAtom(explorerSortFamily));
  const askOnline = (source: ExplorerOnlineSource) => {
    if (statsUnavailable) return false;
    if (firstSource === source) return true;
    if (comparison.kind === "online" && comparison.source === source) return true;
    return furtherShown.some((column) => column.id === source);
  };
  const lichessAllExplorer = useOnlineExplorer(
    "lch_all",
    debouncedFen,
    lichessOptions,
    explorerHandle,
    askOnline("lch_all"),
  );
  const lichessMasterExplorer = useOnlineExplorer(
    "lch_master",
    debouncedFen,
    masterOptions,
    explorerHandle,
    askOnline("lch_master"),
  );

  const onlineName = (source: ExplorerOnlineSource) =>
    source === "lch_all" ? t("Board.Database.LichessAll") : t("Board.Database.LichessMaster");
  const onlineFilters = (source: ExplorerOnlineSource) =>
    source === "lch_all" ? <LichessOptionsPanel /> : <MasterOptionsPanel />;
  const onlineFiltered = (source: ExplorerOnlineSource) =>
    source === "lch_all"
      ? lichessFiltersActive(lichessOptions)
      : masterFiltersActive(masterOptions);
  const onlineExplorer = (source: ExplorerOnlineSource) =>
    source === "lch_all" ? lichessAllExplorer : lichessMasterExplorer;

  type StatsColumn = {
    column: ExplorerColumnId;
    name: string;
    kind: "local" | "online";
    explorer: OpeningData & { loading: boolean; error: string | undefined };
    database: DatabaseHandle | null;
  };
  const localColumn = (
    column: ExplorerColumnId,
    name: string,
    explorer: ReturnType<typeof useLocalExplorer>,
    database: DatabaseHandle,
  ): StatsColumn => ({
    column,
    name,
    kind: "local",
    explorer,
    database,
  });
  const onlineColumn = (column: ExplorerColumnId, source: ExplorerOnlineSource): StatsColumn => {
    return {
      column,
      name: onlineName(source),
      kind: "online",
      explorer: onlineExplorer(source),
      database: null,
    };
  };

  const primaryTitle =
    dbSelectData.find((choice) => choice.value === selectedReferenceDatabase)?.label ?? "";
  const primaryColumn: StatsColumn | null =
    firstSource === "local"
      ? effectiveReferenceDatabase
        ? localColumn("primary", primaryTitle, localExplorer, effectiveReferenceDatabase)
        : null
      : onlineColumn("primary", firstSource);
  const comparisonColumn: StatsColumn | null =
    comparison.kind === "database"
      ? localColumn("comparison", comparison.title, comparisonExplorer, comparison.database)
      : comparison.kind === "online"
        ? onlineColumn("comparison", comparison.source)
        : null;
  // A further Lichess column's identity is the source it shows, so it is passed as both.
  const furtherColumnsStats: StatsColumn[] = furtherShown.map((column) =>
    column.id === "reference"
      ? localColumn("reference", column.title, pinnedReferenceExplorer, column.database)
      : onlineColumn(column.id, column.id),
  );
  const shownColumns = [
    ...(primaryColumn ? [primaryColumn] : []),
    ...(comparisonColumn ? [comparisonColumn] : []),
    ...furtherColumnsStats,
  ];
  const columnUnavailable = (column: StatsColumn) =>
    column.explorer.error !== undefined || (column.kind === "online" && !explorerHandle);
  const statsSources = shownColumns.length > 1 ? shownColumns : null;
  const answeringColumns = shownColumns.filter((column) => !columnUnavailable(column));
  const failedColumns = shownColumns.filter((column) => column.explorer.error !== undefined);
  const missingOnlineAuth = shownColumns.some(
    (column) => column.kind === "online" && !explorerHandle,
  );

  const gamesColumns = [primaryColumn, comparisonColumn].filter((column): column is StatsColumn => {
    if (!column) return false;
    return !(statsUnavailable && column.kind === "online");
  });
  const gamesSource: ExplorerGamesSourceRole = gamesColumns.some(
    (column) => column.column === storedGamesSource,
  )
    ? storedGamesSource
    : gamesColumns[0]?.column === "comparison"
      ? "comparison"
      : "primary";
  const gamesFrom = gamesColumns.find((column) => column.column === gamesSource);
  const oneGamesColumnAmongSeveralStats = gamesColumns.length === 1 && statsSources !== null;

  const openingData: OpeningData | undefined = primaryColumn?.explorer;
  const isLoading = primaryColumn?.explorer.loading ?? false;
  const errorMessage: string | undefined = primaryColumn?.explorer.error;

  // Clearing the native search cache only frees memory; a choice never depends on it.
  const clearSearchCache = () => void Promise.resolve(tauri.clearGames()).catch(() => undefined);
  const chooseFirstSource = (value: string | null) => {
    clearSearchCache();
    if (isOnlineSource(value)) {
      setFirstSource(value);
      return;
    }
    setFirstSource("local");
    const database = databaseHandleFromKey(readableDatabases, value);
    if (pinned) setPinnedDatabase(database);
    else setReferenceDatabase(database);
  };
  const chooseComparison = (value: string | null) => {
    clearSearchCache();
    if (isOnlineSource(value)) {
      setStoredComparison(value);
      return;
    }
    setStoredComparison(databaseHandleFromKey(readableDatabases, value));
  };
  const firstOnline = firstSource === "local" ? null : firstSource;
  const firstLocalKey = firstSource === "local" ? selectedReferenceDatabase : null;
  const comparisonLocalChoices = dbSelectData.filter((choice) => choice.value !== firstLocalKey);
  const onlineSourceChoices = (except: ExplorerOnlineSource | null = null) =>
    ONLINE_SOURCES.filter((source) => source !== except).map((source) => ({
      value: source,
      label: onlineName(source),
    }));
  const comparisonOnlineChoices = onlineSourceChoices(firstOnline);
  const groupedChoices = (local: SelectItem[], online: SelectItem[]): SelectGroup[] => [
    ...(local.length > 0 ? [{ group: t("Board.Database.Databases"), items: local }] : []),
    ...(online.length > 0 ? [{ group: t("Board.Database.Online"), items: online }] : []),
  ];
  const firstSelectData: SelectItem[] | SelectGroup[] = pinned
    ? dbSelectData
    : groupedChoices(dbSelectData, onlineSourceChoices());
  const comparisonSelectData = groupedChoices(comparisonLocalChoices, comparisonOnlineChoices);
  const firstSet = firstSource !== "local" || !!effectiveReferenceDatabase;
  const canCompare =
    !pinned &&
    firstSet &&
    comparison.kind === "none" &&
    (comparisonLocalChoices.length > 0 || comparisonOnlineChoices.length > 0);
  const canAddFurther = pinned && furtherChoices.length > 0;

  const titledSource = (title: string) => (
    <Flex align="center" flex={1} miw={0} h={SOURCE_SELECT_HEIGHT}>
      <Text fz="sm" fw={600} truncate title={title}>
        {title}
      </Text>
    </Flex>
  );

  const sourceSelect = (source: {
    data: SelectItem[] | SelectGroup[];
    value: string | null;
    choose: (value: string | null) => void;
    placeholder?: string;
    name?: string;
  }) => (
    <Select
      data={source.data}
      value={source.value}
      onChange={source.choose}
      placeholder={source.placeholder}
      aria-label={source.name}
      size="sm"
      flex={1}
      miw={0}
      allowDeselect={false}
      maxDropdownHeight={SOURCE_LIST_MAX_HEIGHT}
    />
  );

  /** A local source's cell: each source differs only in its database, title, and filter binding. */
  const localSourceHeader = (source: {
    key: string;
    choices?: SelectItem[] | SelectGroup[];
    database: DatabaseHandle | null;
    choose?: (value: string | null) => void;
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
        source.fixedTitle !== undefined
          ? titledSource(source.fixedTitle)
          : sourceSelect({
              data: source.choices ?? [],
              value: source.database ? databaseHandleKey(source.database) : null,
              choose: source.choose ?? (() => undefined),
              placeholder: source.name ? undefined : t("Board.Database.SelectReference"),
              name: source.name,
            })
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
  const onlineSourceHeader = (source: {
    key: string;
    online: ExplorerOnlineSource;
    select?: ReactNode;
    action?: ReactNode;
  }) => (
    <ExplorerSourceHeader
      key={source.key}
      select={source.select}
      filterLabel={t("Board.Database.Filters")}
      filters={onlineFilters(source.online)}
      action={source.action}
    />
  );
  const removeAction = (label: string, onClick: () => void) => (
    <IconAction label={label} variant="subtle" size="sm" onClick={onClick}>
      <X size="0.875rem" />
    </IconAction>
  );
  const firstHeader =
    firstSource === "local"
      ? localSourceHeader({
          key: "primary",
          choices: firstSelectData,
          database: effectiveReferenceDatabase,
          choose: chooseFirstSource,
          binding: { filters: localFilters, setFilters: setLocalFilters },
          playerName: primaryPlayerName,
        })
      : onlineSourceHeader({
          key: "primary",
          online: firstSource,
          select: sourceSelect({
            data: firstSelectData,
            value: firstSource,
            choose: chooseFirstSource,
          }),
        });
  const comparisonHeader =
    comparison.kind === "database"
      ? localSourceHeader({
          key: "comparison",
          choices: comparisonSelectData,
          database: comparison.database,
          choose: chooseComparison,
          name: t("Board.Database.CompareWith"),
          ...(pinned
            ? { fixedTitle: comparison.title, fixedPlayer: comparisonPlayer !== null }
            : {}),
          binding: comparisonFilters,
          playerName: comparisonPlayerName,
          action: removeAction(t("Board.Database.RemoveComparison"), removeComparison),
        })
      : comparison.kind === "online"
        ? onlineSourceHeader({
            key: "comparison",
            online: comparison.source,
            select: sourceSelect({
              data: comparisonSelectData,
              value: comparison.source,
              choose: chooseComparison,
              name: t("Board.Database.CompareWith"),
            }),
            action: removeAction(t("Board.Database.RemoveComparison"), removeComparison),
          })
        : false;
  const furtherHeaders = furtherShown.map((column) =>
    column.id === "reference"
      ? localSourceHeader({
          key: "reference",
          choices: [],
          database: column.database,
          choose: () => undefined,
          fixedTitle: column.title,
          binding: pinnedReferenceFilters,
          playerName: pinnedReferencePlayerName,
          action: removeAction(t("Board.Database.RemoveReference"), () =>
            setFurtherColumns((columns) => columns.filter((entry) => entry !== "reference")),
          ),
        })
      : onlineSourceHeader({
          key: column.id,
          online: column.id,
          select: titledSource(onlineName(column.id)),
          action: removeAction(t("Board.Database.RemoveColumn"), () =>
            setFurtherColumns((columns) => columns.filter((entry) => entry !== column.id)),
          ),
        }),
  );

  const [storedCollapsed, setStoredCollapsed] = useAtom(explorerHeaderCollapsedAtom);
  // The panel asks for a database through its select, so the controls stay open until the list
  // has answered with one. The stored preference is left as it is.
  const needsDatabase =
    firstSource === "local" &&
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
  const onlineCaption = (key: string, source: ExplorerOnlineSource) => (
    <ExplorerSourceCaption
      key={key}
      name={onlineName(source)}
      detail={onlineFiltered(source) ? t("Board.Database.Filters") : undefined}
    />
  );
  const sourceCaptions = [
    firstSource === "local"
      ? localCaption({
          key: "primary",
          name: primaryTitle,
          filters: localFilters,
          playerName: primaryPlayerName,
        })
      : onlineCaption("primary", firstSource),
    comparison.kind === "database" &&
      localCaption({
        key: "comparison",
        name: comparison.title,
        filters: comparisonFilters.filters,
        playerName: comparisonPlayerName,
      }),
    comparison.kind === "online" && onlineCaption("comparison", comparison.source),
    ...furtherShown.map((column) =>
      column.id === "reference"
        ? localCaption({
            key: "reference",
            name: column.title,
            filters: pinnedReferenceFilters.filters,
            playerName: pinnedReferencePlayerName,
          })
        : onlineCaption(column.id, column.id),
    ),
  ];
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

  const sourceAlert = (source: StatsColumn) => (
    <Alert key={source.column} color="danger" style={{ flexShrink: 0 }}>
      {`${source.name}: ${source.explorer.error}`}
    </Alert>
  );
  const signInNotice = (
    <Alert color="warning" style={{ flexShrink: 0 }}>
      {t("Board.Database.ExplorerAuthRequired1")}{" "}
      <Link to="/accounts">{t("Home.Accounts.Users")}</Link>{" "}
      {t("Board.Database.ExplorerAuthRequired2")}
    </Alert>
  );

  const groupedMenu = (
    local: SelectItem[],
    online: SelectItem[],
    choose: (value: string) => void,
  ) => (
    <>
      {local.length > 0 && (
        <>
          <Menu.Label>{t("Board.Database.Databases")}</Menu.Label>
          {local.map((choice) => (
            <Menu.Item key={choice.value} onClick={() => choose(choice.value)}>
              {choice.label}
            </Menu.Item>
          ))}
        </>
      )}
      {online.length > 0 && (
        <>
          <Menu.Label>{t("Board.Database.Online")}</Menu.Label>
          {online.map((choice) => (
            <Menu.Item key={choice.value} onClick={() => choose(choice.value)}>
              {choice.label}
            </Menu.Item>
          ))}
        </>
      )}
    </>
  );
  const addSourceMenu = (
    label: string,
    accessibleName: string,
    local: SelectItem[],
    online: SelectItem[],
    choose: (value: string) => void,
  ) => (
    <Menu position="bottom-start" withinPortal>
      <Menu.Target>
        <Button
          variant="subtle"
          size="compact-sm"
          leftSection={<Plus size="0.875rem" />}
          aria-label={accessibleName}
        >
          {label}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>{groupedMenu(local, online, choose)}</Menu.Dropdown>
    </Menu>
  );

  const gamesView = (source: StatsColumn) => {
    if (source.kind === "online" && !explorerHandle) return signInNotice;
    if (source.explorer.error !== undefined) return sourceAlert(source);
    const failures = source.explorer.gameFailures;
    const hasGameFailures = (failures?.length ?? 0) > 0;
    const failedGames = failedGameLabels(failures);
    return (
      <>
        {hasGameFailures && (
          <Alert color="warning" style={{ flexShrink: 0 }}>
            {source.explorer.games.length
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
        {(!hasGameFailures || !!source.explorer.games.length) && (
          <GamesTable
            games={source.explorer.games}
            loading={source.explorer.loading}
            databasePath={source.database}
            targetFen={gamesTargetFen}
          />
        )}
      </>
    );
  };

  /** What a view shows instead of its table while the only source cannot answer. */
  const unavailable: ReactNode | null =
    firstSource === "local" && !effectiveReferenceDatabase ? (
      <NoDatabaseWarning />
    ) : errorMessage !== undefined ? (
      <Alert color="danger">{errorMessage}</Alert>
    ) : primaryColumn?.kind === "online" && !explorerHandle ? (
      signInNotice
    ) : null;

  const addFurther = (id: ExplorerFurtherColumn) =>
    setFurtherColumns((columns) => addFurtherColumn(columns, id, furtherContext));
  const furtherMenuItems = furtherChoices.flatMap((id): SelectItem[] => {
    if (id !== "reference") return [{ value: id, label: onlineName(id) }];
    if (availableReference.kind !== "database") return [];
    return [{ value: id, label: availableReference.title }];
  });
  const furtherLocalItems = furtherMenuItems.filter((item) => item.value === "reference");
  const furtherOnlineItems = furtherMenuItems.filter((item) => item.value !== "reference");

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
              {showingLocalSource && <PositionSearchControl boardFen={debouncedFen} />}
              {canCompare &&
                addSourceMenu(
                  t("Board.Database.Compare"),
                  t("Board.Database.CompareWith"),
                  comparisonLocalChoices,
                  comparisonOnlineChoices,
                  chooseComparison,
                )}
              {canAddFurther &&
                addSourceMenu(
                  t("Board.Database.AddColumn"),
                  t("Board.Database.AddColumn"),
                  furtherLocalItems,
                  furtherOnlineItems,
                  (value) => addFurther(value as ExplorerFurtherColumn),
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
            {firstHeader}
            {comparisonHeader}
            {furtherHeaders}
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
            {missingOnlineAuth && signInNotice}
            {failedColumns.map(sourceAlert)}
            {answeringColumns.length > 0 && (
              <OpeningsTable
                openings={primaryColumn?.explorer.openings ?? []}
                loading={primaryColumn?.explorer.loading ?? false}
                sources={statsSources.map((column) => ({
                  column: column.column,
                  openings: column.explorer.openings,
                  loading: column.explorer.loading,
                  total: column.explorer.total,
                  unavailable: columnUnavailable(column),
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
        {gamesColumns.length > 1 && gamesFrom ? (
          <Stack gap="xs" flex={1} style={{ overflow: "hidden" }}>
            <SegmentedControl
              aria-label={t("Board.Database.GamesSource")}
              style={{ flexShrink: 0, alignSelf: "flex-start" }}
              size="xs"
              data={gamesColumns.map((column) => ({
                value: column.column,
                label: column.name,
              }))}
              value={gamesSource}
              onChange={(value) => {
                if (value === "primary" || value === "comparison") setGamesSource(value);
              }}
            />
            {gamesView(gamesFrom)}
          </Stack>
        ) : oneGamesColumnAmongSeveralStats && gamesFrom ? (
          gamesView(gamesFrom)
        ) : (
          (unavailable ?? (primaryColumn ? gamesView(primaryColumn) : null))
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
