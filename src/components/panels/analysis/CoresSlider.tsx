import { SegmentedControl, useMantineTheme } from "@mantine/core";

function hardwareConcurrencyLimit(): number {
  const reported = navigator.hardwareConcurrency;
  return Number.isInteger(reported) && reported >= 1 ? reported : 1;
}

function coreCountOptions(hardwareConcurrency: number, value: number): number[] {
  const options = new Set<number>();
  for (let cores = 1; cores < hardwareConcurrency; cores *= 2) {
    options.add(cores);
  }
  options.add(hardwareConcurrency);
  if (Number.isInteger(value) && value >= 1) {
    options.add(value);
  }
  return [...options].sort((a, b) => a - b);
}

export default function CoresSlider(props: {
  value: number;
  setValue: (v: number) => void;
  color?: string;
}) {
  const theme = useMantineTheme();
  const values = coreCountOptions(hardwareConcurrencyLimit(), props.value);

  return (
    <SegmentedControl
      size="xs"
      color={props.color || theme.primaryColor}
      value={props.value.toString()}
      onChange={(v) => props.setValue(Number.parseInt(v))}
      data={values.map((v) => v.toString())}
    />
  );
}
