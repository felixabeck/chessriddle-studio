import { Button, Group, Popover, Stack, Text } from "@mantine/core";
import { ListFilter } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import classes from "./ExplorerSourceHeader.module.css";

/** The database select never grows beyond this, so a wide cell keeps room for the filter label. */
const SELECT_MAX_WIDTH = 200;
/** Room for the icon action beside the select and the gap between them. */
const ACTION_ALLOWANCE = 30;

/**
 * One explorer source in the sources bar: its database select, the button that names its active
 * filters and opens them, and its own progress bar.
 */
function ExplorerSourceHeader({
  select,
  filterLabel,
  filterDisabled = false,
  filters,
  action,
  loader,
}: {
  select?: ReactNode;
  filterLabel: string;
  filterDisabled?: boolean;
  filters: ReactNode;
  action?: ReactNode;
  loader: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Stack gap={0} miw={0} flex={1} data-explorer-source>
      {/* In a narrow cell the filter button moves below the select instead of squeezing its name. */}
      <Group gap="xs" wrap="wrap">
        {(select || action) && (
          <Group
            gap={4}
            wrap="nowrap"
            flex="1 1 9rem"
            miw={0}
            maw={action ? SELECT_MAX_WIDTH + ACTION_ALLOWANCE : SELECT_MAX_WIDTH}
          >
            {select}
            {action}
          </Group>
        )}
        <Popover position="bottom-start" shadow="md" width="30rem" trapFocus withinPortal>
          <Popover.Target>
            <Button
              variant="default"
              size="compact-sm"
              miw={0}
              disabled={filterDisabled}
              leftSection={<ListFilter size="0.875rem" />}
              aria-label={t("Board.Database.FilterButton", { summary: filterLabel })}
              classNames={{ root: classes.filterButton, label: classes.filterLabel }}
            >
              {filterLabel}
            </Button>
          </Popover.Target>
          <Popover.Dropdown className={classes.filters} data-explorer-filters>
            {filters}
          </Popover.Dropdown>
        </Popover>
      </Group>
      {loader}
    </Stack>
  );
}

/**
 * One explorer source while the header is collapsed: its name, whatever narrows its numbers,
 * and its own progress bar. It takes the header's cell, so it lines up with the same columns.
 */
export function ExplorerSourceCaption({
  name,
  detail,
  loader,
}: {
  name: string;
  detail?: string;
  loader: ReactNode;
}) {
  return (
    <Stack gap={0} miw={0} data-explorer-source>
      <Text fz="sm" fw={600} truncate>
        {name}
        {detail && (
          <Text span fw={400} c="dimmed">
            {` · ${detail}`}
          </Text>
        )}
      </Text>
      {loader}
    </Stack>
  );
}

export default ExplorerSourceHeader;
