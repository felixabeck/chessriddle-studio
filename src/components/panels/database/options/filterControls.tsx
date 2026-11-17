import { Button, Group } from "@mantine/core";
import dayjs from "dayjs";
import { useTranslation } from "react-i18next";

/** Label look shared by every filter in the Local, Lichess and Masters option panels. */
export const FILTER_LABEL_PROPS = { fw: "bold", fz: "sm", mb: 4 } as const;

const YEAR_PRESETS = [1, 3, 5, 10];

/** Rolling windows counted back from today. They set only the start; the end is left as is. */
export function YearPresetButtons({ onPick }: { onPick: (start: dayjs.Dayjs) => void }) {
  const { t } = useTranslation();
  return (
    <Group gap={4}>
      {YEAR_PRESETS.map((years) => (
        <Button
          key={years}
          size="compact-xs"
          variant="default"
          onClick={() => onPick(dayjs().subtract(years, "year"))}
        >
          {t("Board.Database.Local.LastYears", { count: years })}
        </Button>
      ))}
    </Group>
  );
}
