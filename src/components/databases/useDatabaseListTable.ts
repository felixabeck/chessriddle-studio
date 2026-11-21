import { useHotkeys } from "@mantine/hooks";
import type { DataTableSortStatus } from "mantine-datatable";
import { useTranslation } from "react-i18next";
import type { QueryOptions } from "@/bindings";
import { gameRowActivation } from "@/components/common/gameOpen";
import { inlineFailureMessage } from "@/components/files/notifyError";
import { getAdjacentRecordId } from "./pageSelection";
import classes from "./styles.module.css";

const RECORDS_PER_PAGE_OPTIONS = [10, 25, 50];
const DEFAULT_PAGE_SIZE = 25;

type ListQuery = { options?: QueryOptions<unknown> | null };
type SortOf<Q extends ListQuery> = NonNullable<Q["options"]>["sort"];

/**
 * The list contract the Library's game, player and tournament tables share: arrow-key and
 * row selection, row activation, the load-failure empty state, and paging and sorting through
 * the query's options. Each table keeps its columns, its sort mapping and its preview.
 */
export function useDatabaseListTable<R extends { id: number }, Q extends ListQuery>({
    records,
    count,
    error,
    isLoading,
    query,
    setQuery,
    selectedId,
    setSelectedId,
    sortAccessor,
    sortOf,
    emptyText,
    activate,
}: {
    records: R[];
    count: number | null | undefined;
    error: unknown;
    isLoading: boolean;
    query: Q;
    setQuery: (query: Q) => unknown;
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
    const step = (direction: -1 | 1) => {
        const id = getAdjacentRecordId(records, selectedId ?? undefined, direction);
        if (id != null) setSelectedId(id);
    };
    useHotkeys([
        ["ArrowUp", () => step(-1)],
        ["ArrowDown", () => step(1)],
    ]);
    const setOptions = (options: Partial<QueryOptions<SortOf<Q>>>) =>
        setQuery({ ...query, options: { ...query.options!, ...options } });

    return {
        withTableBorder: true,
        highlightOnHover: true,
        records,
        fetching: isLoading,
        customRowAttributes: (record: R) => ({
            ...gameRowActivation(record, activate),
            "aria-selected": record.id === selectedId,
        }),
        rowClassName: (record: R) => (record.id === selectedId ? classes.selected : ""),
        noRecordsText:
            inlineFailureMessage(error, "database", t("Databases.LoadError.Title")) ?? emptyText,
        totalRecords: count!,
        recordsPerPage: query.options?.pageSize ?? DEFAULT_PAGE_SIZE,
        page: query.options?.page ?? 1,
        onPageChange: (page: number) => setOptions({ page }),
        onRecordsPerPageChange: (pageSize: number) => setOptions({ pageSize }),
        sortStatus: {
            columnAccessor: sortAccessor(query.options?.sort),
            direction: query.options?.direction || "desc",
        },
        onSortStatusChange: (status: DataTableSortStatus<R>) => {
            const sort = sortOf(String(status.columnAccessor));
            if (sort !== undefined) setOptions({ sort, direction: status.direction });
        },
        recordsPerPageLabel: t("Common.RecordsPerPage"),
        recordsPerPageOptions: RECORDS_PER_PAGE_OPTIONS,
        onRowClick: ({ record }: { record: R }) => setSelectedId(record.id),
    };
}
