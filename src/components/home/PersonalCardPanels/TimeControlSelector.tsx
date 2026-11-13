import { Select } from "@mantine/core";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import filterClasses from "./StatisticsFilters.module.css";

const LICHESS_TIME_CONTROLS = [
  { value: "ultra_bullet", labelKey: "TimeControl.UltraBullet" },
  { value: "bullet", labelKey: "TimeControl.Bullet" },
  { value: "blitz", labelKey: "TimeControl.Blitz" },
  { value: "rapid", labelKey: "TimeControl.Rapid" },
  { value: "classical", labelKey: "TimeControl.Classical" },
  { value: "correspondence", labelKey: "TimeControl.Correspondence" },
];

const CHESSCOM_TIME_CONTROLS = [
  { value: "bullet", labelKey: "TimeControl.Bullet" },
  { value: "blitz", labelKey: "TimeControl.Blitz" },
  { value: "rapid", labelKey: "TimeControl.Rapid" },
  { value: "daily", labelKey: "TimeControl.Daily" },
];

const ALL_TIME_CONTROLS = [
  ...LICHESS_TIME_CONTROLS,
  ...CHESSCOM_TIME_CONTROLS.filter(
    (control) => !LICHESS_TIME_CONTROLS.some((existing) => existing.value === control.value),
  ),
];

interface TimeControlSelectorProps {
  onTimeControlChange: (value: string | null) => void;
  website: string | null;
  allowAll: boolean;
}

const TimeControlSelector = ({
  onTimeControlChange,
  website,
  allowAll,
}: TimeControlSelectorProps) => {
  const { t } = useTranslation();
  const timeControls = useMemo(() => {
    const categories =
      website === "Chess.com"
        ? CHESSCOM_TIME_CONTROLS
        : website === "Lichess"
          ? LICHESS_TIME_CONTROLS
          : ALL_TIME_CONTROLS;
    return [
      ...(allowAll ? [{ value: "any", label: t("Board.Database.Local.Result.Any") }] : []),
      ...categories.map((control) => ({
        ...control,
        label: t(control.labelKey),
      })),
    ];
  }, [allowAll, t, website]);

  const defaultTimeControl = allowAll ? "any" : "rapid";
  const [timeControl, setTimeControl] = useState<string | null>(defaultTimeControl);

  useEffect(() => {
    onTimeControlChange(timeControl);
  }, [onTimeControlChange, timeControl]);

  useEffect(() => {
    if (!timeControls.some((control) => control.value === timeControl)) {
      setTimeControl(defaultTimeControl);
    }
  }, [defaultTimeControl, timeControl, timeControls]);

  return (
    <Select
      classNames={{ dropdown: filterClasses.dropdown }}
      pt="lg"
      label={t("Board.Database.TimeControl")}
      value={timeControl}
      onChange={(value) => setTimeControl(value)}
      data={timeControls}
      allowDeselect={false}
    />
  );
};

export default TimeControlSelector;
