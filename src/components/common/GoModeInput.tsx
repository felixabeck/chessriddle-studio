import { Group, NumberInput, Select } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { match } from "ts-pattern";
import type { GoMode } from "@/bindings";
import TimeInput from "./TimeInput";

// Native GoMode::validate rejects a zero limit.
const MIN_LIMIT = 1;

function limit(value: string | number): number {
  return typeof value === "number" ? Math.max(MIN_LIMIT, value) : MIN_LIMIT;
}

function GoModeInput({
  goMode,
  setGoMode,
  gameMode,
  timeDefault = 8000,
}: {
  goMode: GoMode | null;
  setGoMode: (v: GoMode) => void;
  gameMode?: boolean;
  timeDefault?: number;
}) {
  const { t } = useTranslation();

  const timeTypes = ["Time", "Depth", "Nodes"];
  if (!gameMode) {
    timeTypes.push("Infinite");
  }

  return (
    <Group wrap="nowrap">
      <Select
        allowDeselect={false}
        data={timeTypes.map((v) => ({ value: v, label: t(`GoMode.${v}`) }))}
        value={goMode?.t || (gameMode ? "Time" : "Infinite")}
        onChange={(v) => {
          const newGo = match<string | null, GoMode>(v)
            .with("Depth", () => ({ t: "Depth", c: 20 }))
            .with("Nodes", () => ({ t: "Nodes", c: 1000000 }))
            .with("Time", () => ({ t: "Time", c: timeDefault }))
            .otherwise(() => ({ t: "Infinite" }));

          setGoMode(newGo);
        }}
      />
      {match(goMode || { t: "Infinite" })
        .with({ t: "Depth" }, (v) => (
          <NumberInput
            min={1}
            value={v.c}
            onChange={(v) => setGoMode({ t: "Depth", c: limit(v) })}
          />
        ))
        .with({ t: "Nodes" }, (v) => (
          <NumberInput
            min={1}
            value={v.c}
            onChange={(v) => setGoMode({ t: "Nodes", c: limit(v) })}
          />
        ))
        .with({ t: "Time" }, (v) => (
          <TimeInput
            value={v.c}
            setValue={(next) =>
              setGoMode(next.t === "Time" ? { t: "Time", c: limit(next.c) } : next)
            }
          />
        ))
        .otherwise(() => null)}
    </Group>
  );
}

export default GoModeInput;
