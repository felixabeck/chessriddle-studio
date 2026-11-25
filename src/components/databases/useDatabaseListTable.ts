import { useHotkeys } from "@mantine/hooks";
import type { DataTableSortStatus } from "mantine-datatable";
import { useTranslation } from "react-i18next";
import type { QueryOptions } from "@/bindings";
import { gameRowActivation } from "@/components/common/gameOpen";
import { inlineFailureMessage } from "@/components/files/notifyError";
import type { RecordsPerPageChoice } from "@/state/store/database";
import { type DatabaseListFooterProps, DEFAULT_PAGE_SIZE } from "./DatabaseListFooter";
import { getAdjacentRecordId } from "./pageSelection";
import classes from "./styles.module.css";
import type { DatabaseListQueryResult } from "./useDatabaseListQuery";
import { useWindowedTableRows } from "./useWindowedTableRows";

type ListQuery = { options?: QueryOptions<unknown> | null };
type SortOf<Q extends ListQuery> = NonNullable<Q["options"]>["sort"];

/**
 * The list contract the Library's game, player and tournament tables share: arrow-key and
 * row selection, row activation, the load-failure empty state, sorting, scroll-to-bottom
 * chunk loading, windowed row rendering in "All" mode, and the shared list footer props.
 */
export function useDatabaseListTable<R extends { id: number }, Q extends ListQuery>({
    list,
    isActive = true,
    query,
    setQuery,
    setRecordsPerPage,
    selectedId,
    setSelectedId,
    sortAccessor,
    sortOf,
    emptyText,
    activate,
}: {
    list: DatabaseListQueryResult<R>;
    /** Whether this list's tab is currently visible; hidden keepMounted tabs ignore arrow keys. */
    isActive?: boolean;
    query: Q;
    setQuery: (query: Q) => unknown;
    setRecordsPerPage: (choice: RecordsPerPageChoice) => unknown;
    selectedId: number | null | undefined;
    setSelectedId: (id: number) => unknown;
    /** The column showing the query's sort. */
    sortAccessor: (sort: SortOf<Q> | undefined) => string;
    /** The query sort for a clicked column, or undefined when that column cannot sort the query. */
    sortOf: (accessor: string) => SortOf<Q> | undefined;
    emptyText: string;
    /** Double-click or Enter on a row. */
    activate: (record: R) => void | Promise<void>;
}) {
    const { t } = useTranslation();
    const {
        records,
        recordsMode: mode,
        count,
        error,
        isLoading,
        isLoadingMore,
        boundReachedWithMore,
        scrollViewportRef,
        loadMore,
        retry,
    } = list;

    const windowing = useWindowedTableRows({
        records,
        enabled: mode === "all",
        scrollViewportRef,
    });

    const step = (direction: -1 | 1) => {
        if (!isActive) return;
        const id = getAdjacentRecordId(records, selectedId ?? undefined, direction);
        if (id != null) {
            setSelectedId(id);
            const nextIndex = records.findIndex((record) => record.id === id);
            if (nextIndex >= 0) windowing.scrollToIndex(nextIndex);
        }
    };
    useHotkeys([
        ["ArrowUp", () => step(-1)],
        ["ArrowDown", () => step(1)],
    ]);
    const setOptions = (options: Partial<QueryOptions<SortOf<Q>>>) =>
        setQuery({ ...query, options: { ...query.options!, ...options } });

    const tableProps = {
        withTableBorder: true,
        highlightOnHover: true,
        height: mode === "all" ? ("100%" as const) : undefined,
        records: windowing.visibleRecords,
        rowFactory: windowing.rowFactory,
        fetching: isLoading,
        scrollViewportRef,
        onScrollToBottom: mode === "all" ? loadMore : undefined,
        customRowAttributes: (record: R) => ({
            ...gameRowActivation(record, activate),
            "aria-selected": record.id === selectedId,
        }),
        rowClassName: (record: R) => (record.id === selectedId ? classes.selected : ""),
        noRecordsText:
            inlineFailureMessage(error, "database", t("Databases.LoadError.Title")) ?? emptyText,
        sortStatus: {
            columnAccessor: sortAccessor(query.options?.sort),
            direction: query.options?.direction || "desc",
        },
        onSortStatusChange: (status: DataTableSortStatus<R>) => {
            const sort = sortOf(String(status.columnAccessor));
            if (sort !== undefined) setOptions({ sort, direction: status.direction });
        },
        onRowClick: ({ record }: { record: R }) => setSelectedId(record.id),
    };

    const footerProps: DatabaseListFooterProps = {
        mode,
        page: query.options?.page ?? 1,
        recordsPerPage: query.options?.pageSize ?? DEFAULT_PAGE_SIZE,
        shownCount: records.length,
        totalRecords: count,
        isLoading,
        isLoadingMore,
        error,
        boundReachedWithMore,
        onPageChange: (page: number) => setOptions({ page }),
        onRecordsPerPageChange: (choice: RecordsPerPageChoice) => {
            setRecordsPerPage(choice);
        },
        onRetry: retry,
    };

    return { tableProps, footerProps };
}
