import { useAtom, useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { enginesAtom } from "@/state/atoms";
import { coachEngineAtom, coachEngines, effectiveCoachEngine } from "@/state/coach";
import SettingsSelect from "../SettingsSelect";

/** The local engine the Coach runs. The stored pick is honoured only while that engine exists. */
export function CoachEngineSelect() {
  const { t } = useTranslation();
  const engines = useAtomValue(enginesAtom);
  const [picked, setPicked] = useAtom(coachEngineAtom);
  const candidates = coachEngines(engines);
  return (
    <SettingsSelect
      data={candidates.map((engine) => ({ value: engine.id, label: engine.name }))}
      value={effectiveCoachEngine(engines, picked)?.id ?? null}
      onChange={(id) => {
        if (id) setPicked(id);
      }}
      allowDeselect={false}
      disabled={candidates.length === 0}
      placeholder={t("Settings.Coach.Engine.None")}
    />
  );
}
