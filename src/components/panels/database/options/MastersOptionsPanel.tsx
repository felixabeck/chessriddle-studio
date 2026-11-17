import { SimpleGrid, Stack } from "@mantine/core";
import { YearPickerInput } from "@mantine/dates";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { masterOptionsAtom } from "@/state/atoms";
import { MIN_DATE } from "@/utils/lichess/api";
import { formatExplorerDate } from "@/utils/lichess/explorer";
import { FILTER_LABEL_PROPS, YearPresetButtons } from "./filterControls";

const MasterOptionsPanel = () => {
  const { t } = useTranslation();
  const [options, setOptions] = useAtom(masterOptionsAtom);
  return (
    <SimpleGrid cols={2}>
      <Stack gap={4}>
        <YearPickerInput
          label={t("Common.From")}
          labelProps={FILTER_LABEL_PROPS}
          placeholder={t("Common.StartDate")}
          value={options.since ? formatExplorerDate(options.since) : null}
          minDate={MIN_DATE}
          maxDate={new Date()}
          onChange={(value) =>
            setOptions({ ...options, since: value ? new Date(value) : undefined })
          }
          clearable
        />
        <YearPresetButtons onPick={(start) => setOptions({ ...options, since: start.toDate() })} />
      </Stack>
      <YearPickerInput
        label={t("Common.To")}
        labelProps={FILTER_LABEL_PROPS}
        placeholder={t("Common.EndDate")}
        value={options.until ? formatExplorerDate(options.until) : null}
        minDate={MIN_DATE}
        maxDate={new Date()}
        onChange={(value) => setOptions({ ...options, until: value ? new Date(value) : undefined })}
        clearable
      />
    </SimpleGrid>
  );
};

export default MasterOptionsPanel;
