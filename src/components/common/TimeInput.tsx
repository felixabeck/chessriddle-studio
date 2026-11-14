import { NumberInput, Select } from "@mantine/core";
import { useState } from "react";
import { match } from "ts-pattern";
import type { GoMode } from "@/bindings";

export type TimeType = "ms" | "s" | "m" | "h";
function TimeInput({
  value,
  setValue,
  defaultType,
  type,
  onTypeChange,
}: {
  value: number;
  setValue: (v: GoMode) => void;
  defaultType?: TimeType;
  type?: TimeType;
  onTypeChange?: (type: TimeType) => void;
}) {
  const [internalTimeType, setInternalTimeType] = useState<TimeType>(defaultType ?? "ms");

  const timeType = type ?? internalTimeType;
  const handleTypeChange = (newType: TimeType) => {
    if (onTypeChange) {
      onTypeChange(newType);
    } else {
      setInternalTimeType(newType);
    }
  };

  const displayedValue = match(timeType)
    .with("ms", () => value)
    .with("s", () => value / 1000)
    .with("m", () => value / 1000 / 60)
    .with("h", () => value / 1000 / 60 / 60)
    .exhaustive();

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
      min={0}
      decimalScale={3}
      hideControls
      rightSection={
        <Select
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
      value={displayedValue}
      onChange={(v) => {
        if (typeof v === "number") {
          setValue({ t: "Time", c: toMilliseconds(v) });
          return;
        }
        if (v === "") {
          setValue({ t: "Time", c: 1 });
          return;
        }
        const parsed = Number(v);
        if (Number.isFinite(parsed)) {
          setValue({ t: "Time", c: toMilliseconds(parsed) });
        }
      }}
    />
  );
}

export default TimeInput;
