import { NumberInput, Select } from "@mantine/core";
import { useState } from "react";
import { match } from "ts-pattern";
import type { GoMode } from "@/bindings";
import { useNumberInputDraft } from "./DraftNumberInput";

export type TimeType = "ms" | "s" | "m" | "h";
// Native GoMode::validate rejects a zero time.
const EMPTY_FIELD_MS = 1;

function TimeInput({
  value,
  setValue,
  defaultType,
  type,
  onTypeChange,
  id,
  unitLabel,
  ariaLabel,
}: {
  value: number;
  setValue: (v: GoMode) => void;
  defaultType?: TimeType;
  type?: TimeType;
  onTypeChange?: (type: TimeType) => void;
  id?: string;
  unitLabel?: string;
  ariaLabel?: string;
}) {
  const [internalTimeType, setInternalTimeType] = useState<TimeType>(defaultType ?? "ms");
  const timeType = type ?? internalTimeType;
  const displayedValue = match(timeType)
    .with("ms", () => value)
    .with("s", () => value / 1000)
    .with("m", () => value / 1000 / 60)
    .with("h", () => value / 1000 / 60 / 60)
    .exhaustive();
  const draft = useNumberInputDraft(displayedValue);
  const handleTypeChange = (newType: TimeType) => {
    draft.reset();
    if (onTypeChange) {
      onTypeChange(newType);
    } else {
      setInternalTimeType(newType);
    }
  };

  const toMilliseconds = (amount: number) =>
    Math.round(
      match(timeType)
        .with("ms", () => amount)
        .with("s", () => amount * 1000)
        .with("m", () => amount * 1000 * 60)
        .with("h", () => amount * 1000 * 60 * 60)
        .exhaustive(),
    );

  return (
    <NumberInput
      id={id}
      aria-label={ariaLabel}
      min={0}
      decimalScale={3}
      hideControls
      rightSection={
        <Select
          aria-label={unitLabel}
          withCheckIcon={false}
          data={["ms", "s", "m", "h"]}
          defaultValue="ms"
          allowDeselect={false}
          value={timeType}
          withScrollArea={false}
          onChange={(v) => handleTypeChange(v as TimeType)}
          styles={{
            option: {
              wordBreak: "keep-all",
              overflow: "hidden",
            },
          }}
        />
      }
      rightSectionWidth={"30%"}
      value={draft.value}
      onBlur={draft.reset}
      onChange={(v) => {
        draft.track(v);
        if (typeof v === "number") {
          setValue({ t: "Time", c: toMilliseconds(v) });
          return;
        }
        if (v === "") {
          setValue({ t: "Time", c: EMPTY_FIELD_MS });
          return;
        }
        // Mantine passes intermediate text such as "1." or "0.0" as a string.
        const parsed = Number(v);
        if (Number.isFinite(parsed)) {
          setValue({ t: "Time", c: toMilliseconds(parsed) });
        }
      }}
    />
  );
}

export default TimeInput;
