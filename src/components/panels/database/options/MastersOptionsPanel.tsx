import { Group } from "@mantine/core";
import { YearPickerInput } from "@mantine/dates";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { masterOptionsAtom } from "@/state/atoms";
import { MIN_DATE } from "@/utils/lichess/api";
import { formatExplorerDate } from "@/utils/lichess/explorer";

const MasterOptionsPanel = () => {
  const { t } = useTranslation();
  const [options, setOptions] = useAtom(masterOptionsAtom);
  return (
    <Group grow>
      <YearPickerInput
        label={t("Common.Since")}
        placeholder={t("Common.PickDate")}
        value={options.since ? formatExplorerDate(options.since) : null}
        minDate={MIN_DATE}
        maxDate={new Date()}
        onChange={(value) => setOptions({ ...options, since: value ? new Date(value) : undefined })}
        clearable
      />
      <YearPickerInput
        label={t("Common.Until")}
        placeholder={t("Common.PickDate")}
        value={options.until ? formatExplorerDate(options.until) : null}
        minDate={MIN_DATE}
        maxDate={new Date()}
        onChange={(value) => setOptions({ ...options, until: value ? new Date(value) : undefined })}
        clearable
      />
    </Group>
  );
};

export default MasterOptionsPanel;
