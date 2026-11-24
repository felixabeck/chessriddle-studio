import { Progress, type ProgressRootProps, Tooltip } from "@mantine/core";
import type { CSSProperties, Ref } from "react";

export type ResultBarSegment = {
  /** Percent 0-100 */
  value: number;
  color?: string;
  className?: string;
  label?: string;
  labelColor?: string;
  labelStyle?: CSSProperties;
  tooltip?: string;
};

// The remaining root props and the ref reach Progress.Root, so a wrapping Mantine Tooltip can
// attach its anchor ref and hover handlers to the bar.
export type ResultBarProps = Omit<ProgressRootProps, "children"> & {
  ref?: Ref<HTMLDivElement>;
  segments: [ResultBarSegment, ResultBarSegment, ResultBarSegment];
};

function Section({ segment }: { segment: ResultBarSegment }) {
  const section = (
    <Progress.Section value={segment.value} color={segment.color} className={segment.className}>
      {segment.label !== undefined && (
        <Progress.Label c={segment.labelColor} style={segment.labelStyle}>
          {segment.label}
        </Progress.Label>
      )}
    </Progress.Section>
  );

  return segment.tooltip !== undefined ? (
    <Tooltip label={segment.tooltip}>{section}</Tooltip>
  ) : (
    section
  );
}

export function ResultBar({ segments, ...rootProps }: ResultBarProps) {
  return (
    <Progress.Root {...rootProps}>
      <Section segment={segments[0]} />
      <Section segment={segments[1]} />
      <Section segment={segments[2]} />
    </Progress.Root>
  );
}
