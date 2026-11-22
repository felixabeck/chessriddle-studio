import { Select, SimpleGrid, Stack, Switch, Text } from "@mantine/core";
import { DateInput } from "@mantine/dates";
import dayjs from "dayjs";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { EloRangeSlider } from "@/components/common/EloRangeSlider";
import { PlayerSearchInput } from "@/components/databases/PlayerSearchInput";
import type { DatabaseHandle } from "@/bindings";
import type { ExplorerFilters } from "@/state/explorerFilters";
import { databaseHandleKey } from "@/utils/db";
import { FilterField, PlaysAsControl, YearPresetButtons } from "./filterControls";

// The form lives in a popover: its own dropdowns stay inside it, so using one is not a click
// outside that would close the filters.
const NESTED = { withinPortal: false } as const;

/** The filters of one local explorer source. Where they are kept is the caller's binding. */
function LocalFiltersForm({
  database,
  filters,
  setFilters,
  fixedPlayer = false,
}: {
  database: DatabaseHandle | null;
  filters: ExplorerFilters;
  setFilters: (update: (current: ExplorerFilters) => ExplorerFilters) => void;
  /** The source's player is given and cannot be chosen here, so the form offers no player input. */
  fixedPlayer?: boolean;
}) {
  const { t } = useTranslation();
  const databaseKey = database ? databaseHandleKey(database) : undefined;
  const [resultDropdownOpened, setResultDropdownOpened] = useState(false);

  return (
    <Stack>
      <SimpleGrid cols={2}>
        {!fixedPlayer && (
          <FilterField label={t("Board.Database.Local.Player")}>
            {database && (
              <PlayerSearchInput
                key={databaseKey}
                label={t("Common.Search")}
                value={filters.player ?? undefined}
                file={database}
                setValue={(v) => setFilters((q) => ({ ...q, player: v ?? null }))}
                withinPortal={false}
              />
            )}
          </FilterField>
        )}
        {/* Without the player cell the control takes the row, so From and To stay side by side. */}
        <div style={fixedPlayer ? { gridColumn: "1 / -1" } : undefined}>
          <PlaysAsControl
            value={filters.color}
            onChange={(color) => setFilters((q) => ({ ...q, color }))}
            hasPlayer={filters.player !== null}
          />
        </div>

        <FilterField label={t("Common.From")}>
          <DateInput
            placeholder={t("Common.StartDate")}
            valueFormat="YYYY-MM-DD"
            popoverProps={NESTED}
            clearable
            value={filters.start_date ? dayjs(filters.start_date, "YYYY.MM.DD").toDate() : null}
            onChange={(value) =>
              setFilters((q) => ({
                ...q,
                start_date: value ? dayjs(value).format("YYYY.MM.DD") : undefined,
              }))
            }
          />
          <YearPresetButtons
            onPick={(day) => setFilters((q) => ({ ...q, start_date: day.replaceAll("-", ".") }))}
          />
        </FilterField>
        <FilterField label={t("Common.To")}>
          <DateInput
            placeholder={t("Common.EndDate")}
            valueFormat="YYYY-MM-DD"
            popoverProps={NESTED}
            clearable
            value={filters.end_date ? dayjs(filters.end_date, "YYYY.MM.DD").toDate() : null}
            onChange={(value) =>
              setFilters((q) => ({
                ...q,
                end_date: value ? dayjs(value).format("YYYY.MM.DD") : undefined,
              }))
            }
          />
        </FilterField>

        <FilterField label={t("Board.Database.Local.Result")}>
          <Select
            // Mantine's non-searchable Select does not assign the combobox role or expanded state.
            role="combobox"
            aria-label={t("Board.Database.Local.Result")}
            attributes={{ input: { "aria-expanded": resultDropdownOpened } }}
            onDropdownOpen={() => setResultDropdownOpened(true)}
            onDropdownClose={() => setResultDropdownOpened(false)}
            data={[
              { value: "any", label: t("Board.Database.Local.Result.Any") },
              {
                value: "whitewon",
                label: t("Board.Database.Local.Result.WhiteWon"),
              },
              { value: "draw", label: t("Board.Analysis.Tablebase.Draw") },
              {
                value: "blackwon",
                label: t("Board.Database.Local.Result.BlackWon"),
              },
            ]}
            value={filters.result}
            onChange={(v) => {
              if (v === "any" || v === "whitewon" || v === "draw" || v === "blackwon")
                setFilters((q) => ({ ...q, result: v }));
            }}
            allowDeselect={false}
            comboboxProps={NESTED}
          />
        </FilterField>
      </SimpleGrid>

      <FilterField label={t("Board.Database.Local.Elo")}>
        <Text c="dimmed" fz="xs">
          {t("Board.Database.Local.Elo.BothPlayers")}
        </Text>
        <EloRangeSlider
          thumbFromLabel={t("Board.Database.Local.Elo.Min")}
          thumbToLabel={t("Board.Database.Local.Elo.Max")}
          value={filters.elo}
          onCommit={(value) => setFilters((q) => ({ ...q, elo: value }))}
        />
      </FilterField>

      <Switch
        // Mantine's label element also wraps the description; keep the accessible name to the label.
        aria-label={t("Board.Database.Local.ExcludeFastEvents")}
        label={t("Board.Database.Local.ExcludeFastEvents")}
        description={t("Board.Database.Local.ExcludeFastEvents.Description")}
        checked={filters.exclude_fast_events ?? false}
        onChange={(event) => {
          const checked = event.currentTarget.checked;
          setFilters((q) => ({ ...q, exclude_fast_events: checked }));
        }}
      />
    </Stack>
  );
}

export default LocalFiltersForm;
