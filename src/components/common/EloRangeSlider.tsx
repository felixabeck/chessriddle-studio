import { RangeSlider } from "@mantine/core";
import { useState } from "react";
import { ELO_FILTER_MAX } from "@/utils/db";

const ELO_MARKS = [1000, 2000, ELO_FILTER_MAX].map((value) => ({
  value,
  label: String(value),
}));

export interface EloRangeSliderProps {
  value: [number, number] | null | undefined;
  onCommit: (value: [number, number]) => void;
  thumbFromLabel?: string;
  thumbToLabel?: string;
}

/** Shared Elo range slider that keeps drag state local until release. */
export function EloRangeSlider({
  value,
  onCommit,
  thumbFromLabel,
  thumbToLabel,
}: EloRangeSliderProps) {
  const [draft, setDraft] = useState<[number, number] | null>(null);

  return (
    <RangeSlider
      thumbFromLabel={thumbFromLabel}
      thumbToLabel={thumbToLabel}
      step={10}
      min={0}
      max={ELO_FILTER_MAX}
      marks={ELO_MARKS}
      value={draft ?? value ?? [0, ELO_FILTER_MAX]}
      onChange={setDraft}
      onChangeEnd={(v) => {
        // Commit once per drag so the search does not rerun on every tick.
        setDraft(null);
        onCommit(v);
      }}
    />
  );
}
