import { Button, Group, Loader, Menu, Pagination, Text } from "@mantine/core";
import { ChevronsUpDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { inlineFailureMessage } from "@/components/files/notifyError";
import type { ListDisplayMode, RecordsPerPageChoice } from "@/state/store/database";
import { ALL_RECORDS_MAX_ROWS } from "./useDatabaseListQuery";
import classes from "./DatabaseListFooter.module.css";

const RECORDS_PER_PAGE_OPTIONS = [10, 25, 50] as const;
export const DEFAULT_PAGE_SIZE = 25;

const MENU_OPTIONS: readonly RecordsPerPageChoice[] = [...RECORDS_PER_PAGE_OPTIONS, "all"];

export type DatabaseListFooterProps = {
  mode: ListDisplayMode;
  page: number;
  recordsPerPage: number;
  shownCount: number;
  totalRecords?: number | null;
  isLoading?: boolean;
  isLoadingMore?: boolean;
  error?: unknown;
  boundReachedWithMore?: boolean;
  onPageChange: (page: number) => void;
  onRecordsPerPageChange: (choice: RecordsPerPageChoice) => void;
  onRetry?: () => void;
};

/**
 * Shared footer rendered outside `DataTable` for the Library games, players, tournaments and
 * tournament-card game lists. Stays mounted when zero rows match so the user can always change
 * records-per-page or retry a failed load.
 */
export function DatabaseListFooter({
  mode,
  page,
  recordsPerPage,
  shownCount,
  totalRecords,
  isLoading = false,
  isLoadingMore = false,
  error,
  boundReachedWithMore = false,
  onPageChange,
  onRecordsPerPageChange,
  onRetry,
}: DatabaseListFooterProps) {
  const { t } = useTranslation();
  const failureMessage = inlineFailureMessage(error, "database", t("Databases.LoadError.Title"));

  const totalPages =
    typeof totalRecords === "number" && totalRecords > 0
      ? Math.max(1, Math.ceil(totalRecords / recordsPerPage))
      : 0;
  const rangeFrom = (page - 1) * recordsPerPage + 1;
  const rangeTo =
    typeof totalRecords === "number"
      ? Math.min(rangeFrom + shownCount - 1, totalRecords)
      : rangeFrom + shownCount - 1;

  return (
    <div className={classes.footer} data-database-list-footer>
      <Group gap="xs" wrap="wrap">
        {mode === "paged" &&
          typeof totalRecords === "number" &&
          totalRecords > 0 &&
          shownCount > 0 && (
            <Text size="sm" className={classes.tabular}>
              {`${rangeFrom} - ${rangeTo} / ${totalRecords}`}
            </Text>
          )}

        {mode === "all" && typeof totalRecords === "number" && (
          <Text size="sm" c="dimmed" className={classes.tabular}>
            {t("Databases.List.ShowingOf", {
              shown: shownCount,
              total: totalRecords,
            })}
          </Text>
        )}

        {mode === "all" && totalRecords == null && shownCount > 0 && (
          <Text size="sm" c="dimmed" className={classes.tabular}>
            {t("Databases.List.ShowingCount", { shown: shownCount })}
          </Text>
        )}

        {mode === "all" && isLoadingMore && <Loader size="xs" aria-label={t("Common.Loading")} />}

        {mode === "all" && boundReachedWithMore && (
          <Text size="sm" c="dimmed">
            {t("Databases.List.BoundReached", { max: ALL_RECORDS_MAX_ROWS })}
          </Text>
        )}
      </Group>

      {failureMessage && (
        <Group gap="xs" role="alert">
          <Text size="sm" c="danger">
            {failureMessage}
          </Text>
          {onRetry && (
            <Button size="xs" variant="default" onClick={onRetry}>
              {t("Common.Retry")}
            </Button>
          )}
        </Group>
      )}

      <Group gap="xs" wrap="wrap">
        <Text component="div" size="sm">
          {t("Common.RecordsPerPage")}
        </Text>
        <Menu withinPortal withArrow offset={2}>
          <Menu.Target>
            <Button
              size="sm"
              variant="default"
              className={classes.pageSizeButton}
              rightSection={<ChevronsUpDown size="0.875rem" strokeWidth={2} />}
            >
              {mode === "all" ? t("Common.All") : recordsPerPage}
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            {MENU_OPTIONS.map((option) => {
              const active =
                option === "all" ? mode === "all" : mode === "paged" && option === recordsPerPage;
              return (
                <Menu.Item
                  key={String(option)}
                  // src/styles/Menu.module.css keeps this active disabled item at full opacity and primary highlight.
                  className={
                    active
                      ? `${classes.pageSizeItem} mantine-datatable-page-size-selector-active`
                      : classes.pageSizeItem
                  }
                  disabled={active}
                  onClick={() => onRecordsPerPageChange(option)}
                >
                  <Text component="div" size="sm">
                    {option === "all" ? t("Common.All") : option}
                  </Text>
                </Menu.Item>
              );
            })}
          </Menu.Dropdown>
        </Menu>

        {mode === "paged" && totalPages > 0 && (
          <Pagination
            size="sm"
            value={page}
            total={totalPages}
            onChange={onPageChange}
            disabled={isLoading}
          />
        )}
      </Group>
    </div>
  );
}
