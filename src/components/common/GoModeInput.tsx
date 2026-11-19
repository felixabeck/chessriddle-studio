import { Group, Select } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { match } from "ts-pattern";
import type { GoMode } from "@/bindings";
import { MAX_GO_NODES, MAX_GO_TIME_OR_DEPTH } from "@/utils/engines";
import DraftNumberInput from "./DraftNumberInput";
import TimeInput from "./TimeInput";

// Native GoMode::validate rejects a zero limit.
const MIN_LIMIT = 1;

function limit(value: number, max: number): number {
  return Math.min(max, Math.max(MIN_LIMIT, Math.trunc(value)));
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
        aria-label={t("GoMode.Limit")}
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
          <DraftNumberInput
            aria-label={t("GoMode.Depth")}
            min={1}
            max={MAX_GO_TIME_OR_DEPTH}
            allowDecimal={false}
            value={v.c}
            onChange={(v) => {
              if (typeof v === "number")
                setGoMode({ t: "Depth", c: limit(v, MAX_GO_TIME_OR_DEPTH) });
            }}
          />
        ))
        .with({ t: "Nodes" }, (v) => (
          <DraftNumberInput
            aria-label={t("GoMode.Nodes")}
            min={1}
            max={MAX_GO_NODES}
            allowDecimal={false}
            value={v.c}
            onChange={(v) => {
              if (typeof v === "number") setGoMode({ t: "Nodes", c: limit(v, MAX_GO_NODES) });
            }}
          />
        ))
        .with({ t: "Time" }, (v) => (
          <TimeInput
            value={v.c}
            ariaLabel={t("GoMode.Time")}
            unitLabel={t("GoMode.TimeUnit")}
            setValue={(next) =>
              setGoMode(
                next.t === "Time" ? { t: "Time", c: limit(next.c, MAX_GO_TIME_OR_DEPTH) } : next,
              )
            }
          />
        ))
        .otherwise(() => null)}
    </Group>
  );
}

export default GoModeInput;
