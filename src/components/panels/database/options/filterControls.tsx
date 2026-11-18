import { Button, Group, SegmentedControl, Stack, Text } from "@mantine/core";
import { MonthPickerInput, YearPickerInput } from "@mantine/dates";
import dayjs from "dayjs";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { MIN_DATE } from "@/utils/lichess/api";
import { formatExplorerDate } from "@/utils/lichess/explorer";

const FILTER_LABEL_STYLE = { fw: "bold", fz: "sm" } as const;

/** `labelProps` that give a Mantine input's own label the look of `FilterField`'s label. */
export const FILTER_LABEL_PROPS = { ...FILTER_LABEL_STYLE, mb: 4 } as const;

/** One labelled filter of the Local, Lichess and Masters option panels. */
export function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack gap={4}>
      <Text {...FILTER_LABEL_STYLE}>{label}</Text>
      {children}
    </Stack>
  );
}

type PlayerColor = "white" | "black";

/** Which side the selected player has; meaningless, and therefore disabled, without a player. */
export function PlaysAsControl({
  value,
  onChange,
  hasPlayer,
}: {
  value: PlayerColor;
  onChange: (color: PlayerColor) => void;
  hasPlayer: boolean;
}) {
  const { t } = useTranslation();
  return (
    <FilterField label={t("Board.Database.Local.PlaysAs")}>
      <SegmentedControl
        fullWidth
        disabled={!hasPlayer}
        data={[
          { value: "white", label: t("Fen.White") },
          { value: "black", label: t("Fen.Black") },
        ]}
        value={value}
        onChange={(v) => onChange(v as PlayerColor)}
      />
    </FilterField>
  );
}

const YEAR_PRESETS = [1, 3, 5, 10];

/**
 * Rolling windows counted back from today's local calendar day. They set only the start; the end
 * is left as is. `onPick` receives that day as `YYYY-MM-DD`.
 */
export function YearPresetButtons({ onPick }: { onPick: (startDay: string) => void }) {
  const { t } = useTranslation();
  return (
    <Group gap={4}>
      {YEAR_PRESETS.map((years) => (
        <Button
          key={years}
          size="compact-xs"
          variant="default"
          onClick={() => onPick(dayjs().subtract(years, "year").format("YYYY-MM-DD"))}
        >
          {t("Board.Database.Local.LastYears", { count: years })}
        </Button>
      ))}
    </Group>
  );
}

interface ExplorerDateRangeValue {
  since?: Date;
  until?: Date;
}

/**
 * From/To of the two Lichess explorers, as two cells of the caller's grid. The stored dates are
 * UTC calendar days (`formatExplorerDate`), so every write goes through `new Date("YYYY-MM-DD")`.
 */
export function ExplorerDateRange({
  precision,
  value,
  onChange,
}: {
  precision: "month" | "year";
  value: ExplorerDateRangeValue;
  onChange: (change: ExplorerDateRangeValue) => void;
}) {
  const { t } = useTranslation();
  const Picker = precision === "month" ? MonthPickerInput : YearPickerInput;
  const toStored = (day: string | null) => (day ? new Date(day) : undefined);
  const shared = {
    labelProps: FILTER_LABEL_PROPS,
    minDate: MIN_DATE,
    maxDate: new Date(),
    clearable: true,
    // These pickers live in the source's filter popover and must not count as a click outside it.
    popoverProps: { withinPortal: false },
  };
  return (
    <>
      <Stack gap={4}>
        <Picker
          {...shared}
          label={t("Common.From")}
          placeholder={t("Common.StartDate")}
          value={value.since ? formatExplorerDate(value.since) : null}
          onChange={(day) => onChange({ since: toStored(day) })}
        />
        <YearPresetButtons onPick={(day) => onChange({ since: toStored(day) })} />
      </Stack>
      <Picker
        {...shared}
        label={t("Common.To")}
        placeholder={t("Common.EndDate")}
        value={value.until ? formatExplorerDate(value.until) : null}
        onChange={(day) => onChange({ until: toStored(day) })}
      />
    </>
  );
}
