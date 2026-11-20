import { RangeSlider } from "@mantine/core";
import { useTranslation } from "react-i18next";

interface TimeRangeSliderProps {
  ratingDates: number[];
  dateRange: { start: number; end: number };
  onDateRangeChange: (range: { start: number; end: number }) => void;
}

const TimeRangeSlider = ({ ratingDates, dateRange, onDateRangeChange }: TimeRangeSliderProps) => {
  const { i18n } = useTranslation();
  return (
    <RangeSlider
      pt="lg"
      label={(value) => new Date(ratingDates[value]).toLocaleDateString(i18n.language)}
      value={[dateRange.start, dateRange.end]}
      onChange={(value) => onDateRangeChange({ start: value[0], end: value[1] })}
      min={0}
      max={ratingDates.length - 1 > 0 ? ratingDates.length - 1 : 0}
      step={1}
      minRange={1}
      styles={{
        root: {
          paddingLeft: "4rem",
          paddingRight: "1rem",
        },
      }}
    />
  );
};

export default TimeRangeSlider;
