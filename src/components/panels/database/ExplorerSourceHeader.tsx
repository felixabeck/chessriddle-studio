import { Button, Group, Stack, Text } from "@mantine/core";
import { ListFilter } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import AppPopover from "@/components/common/AppPopover";
import classes from "./ExplorerSourceHeader.module.css";

/** The database select never grows beyond this, so a wide cell keeps room for the filter label. */
const SELECT_MAX_WIDTH = 200;
/** Room for the icon action beside the select and the gap between them. */
const ACTION_ALLOWANCE = 30;

/**
 * One explorer source in the sources bar: its database select, the button that names its active
 * filters and opens them.
 */
function ExplorerSourceHeader({
  select,
  filterLabel,
  filterDisabled = false,
  filters,
  action,
}: {
  select?: ReactNode;
  filterLabel: string;
  filterDisabled?: boolean;
  filters: ReactNode;
  action?: ReactNode;
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
        <AppPopover position="bottom-start" shadow="md" width="30rem" withinPortal>
          <AppPopover.Target>
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
          </AppPopover.Target>
          <AppPopover.Dropdown className={classes.filters} data-explorer-filters>
            {filters}
          </AppPopover.Dropdown>
        </AppPopover>
      </Group>
    </Stack>
  );
}

/**
 * One explorer source while the header is collapsed: its name and whatever narrows its numbers.
 * It takes the header's cell, so it lines up with the same columns.
 */
export function ExplorerSourceCaption({ name, detail }: { name: string; detail?: string }) {
  return (
    <Stack gap={0} miw={0} data-explorer-source>
      <Text fz="sm" fw={600} truncate title={name}>
        {name}
      </Text>
      {/* Its own line, so a long database name never hides whose games the column shows. */}
      {detail && (
        <Text fz="xs" c="dimmed" truncate title={detail} data-explorer-source-detail>
          {detail}
        </Text>
      )}
    </Stack>
  );
}

export default ExplorerSourceHeader;
