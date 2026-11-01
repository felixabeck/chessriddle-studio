import { SegmentedControl, useMantineTheme } from "@mantine/core";

export const LINE_COUNT_OPTIONS = [1, 2, 3, 4, 5];

export default function LinesSlider(props: {
  value: number;
  setValue: (v: number) => void;
  color?: string;
  /** Options above this count are disabled. */
  max?: number;
  "aria-label"?: string;
}) {
  const theme = useMantineTheme();

  return (
    <SegmentedControl
      size="xs"
      aria-label={props["aria-label"]}
      color={props.color || theme.primaryColor}
      data={LINE_COUNT_OPTIONS.map((count) => ({
        value: count.toString(),
        label: count.toString(),
        disabled: props.max !== undefined && count > props.max,
      }))}
      value={props.value.toString()}
      onChange={(v) => props.setValue(Number.parseInt(v))}
    />
  );
}
