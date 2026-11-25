import { SegmentedControl } from "@mantine/core";
import { useAtom } from "jotai";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  PRACTICE_TRAIN_MINUTES,
  practiceTrainMinutesAtom,
  type PracticeTrainMinutes,
} from "@/state/atoms";

export default function TrainMinutesControl({
  fullWidth,
  disabled,
  ariaLabel,
}: {
  fullWidth?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const { t } = useTranslation();
  const [minutes, setMinutes] = useAtom(practiceTrainMinutesAtom);
  const data = useMemo(
    () =>
      PRACTICE_TRAIN_MINUTES.map((value) => ({
        value: String(value),
        label: t("Home.TrainOpenings.Minutes", { minutes: value }),
      })),
    [t],
  );

  return (
    <SegmentedControl
      fullWidth={fullWidth}
      size="xs"
      aria-label={ariaLabel}
      disabled={disabled}
      value={String(minutes)}
      onChange={(value) => setMinutes(Number(value) as PracticeTrainMinutes)}
      data={data}
    />
  );
}
