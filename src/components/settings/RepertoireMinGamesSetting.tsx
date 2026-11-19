import { Group } from "@mantine/core";
import { useAtom } from "jotai";
import { useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import DraftNumberInput from "@/components/common/DraftNumberInput";
import { coverageMinGamesAtom } from "@/state/atoms";
import { SettingLabelContext } from "./SettingsLayout";
import SettingsSelect from "./SettingsSelect";

const PRESET_MIN_GAMES = { essential: 200, standard: 50, deep: 20 } as const;
type Preset = keyof typeof PRESET_MIN_GAMES | "custom";

function presetFor(minGames: number): Preset {
  const match = (Object.keys(PRESET_MIN_GAMES) as (keyof typeof PRESET_MIN_GAMES)[]).find(
    (preset) => PRESET_MIN_GAMES[preset] === minGames,
  );
  return match ?? "custom";
}

export default function RepertoireMinGamesSetting() {
  const { t, i18n } = useTranslation();
  const inheritedLabel = useContext(SettingLabelContext);
  const [minGames, setMinGames] = useAtom(coverageMinGamesAtom);
  const [preset, setPreset] = useState<Preset>(() => presetFor(minGames));

  // Custom stays selected while the user is in it: each whole number typed in
  // the free-entry field is written to the atom, and re-deriving the preset
  // from an intermediate value (the "50" on the way to "500") would switch to
  // that preset and unmount the field mid-typing. Only a change made while a
  // preset is selected re-derives it.
  useEffect(() => {
    setPreset((current) => (current === "custom" ? current : presetFor(minGames)));
  }, [minGames]);

  // The count goes through Intl so the rendered number follows the active
  // locale by construction. Today's three presets are all below any grouping
  // boundary, so no supported locale changes them — this is about not baking a
  // number's shape into the source, not about a visible difference now.
  const data = useMemo(() => {
    const count = new Intl.NumberFormat(i18n.language);
    return [
      {
        value: "essential",
        label: `${t("Settings.Repertoire.Essential")} (${count.format(PRESET_MIN_GAMES.essential)})`,
      },
      {
        value: "standard",
        label: `${t("Settings.Repertoire.Standard")} (${count.format(PRESET_MIN_GAMES.standard)})`,
      },
      {
        value: "deep",
        label: `${t("Settings.Repertoire.Deep")} (${count.format(PRESET_MIN_GAMES.deep)})`,
      },
      { value: "custom", label: t("Settings.Repertoire.Custom") },
    ];
  }, [t, i18n.language]);

  return (
    <Group wrap="nowrap">
      <SettingsSelect
        w={200}
        allowDeselect={false}
        data={data}
        value={preset}
        onChange={(val) => {
          const next = (val ?? "custom") as Preset;
          if (next !== "custom") setMinGames(PRESET_MIN_GAMES[next]);
          setPreset(next);
        }}
      />
      {preset === "custom" && (
        <DraftNumberInput
          w={100}
          aria-label={inheritedLabel}
          value={minGames}
          onChange={(val) => {
            // Mantine passes a string for an empty, leading-zero or over-long
            // (beyond the safe integer range) draft and a whole number
            // otherwise (allowDecimal is off); a number >= 1 is stored.
            if (typeof val === "number" && val >= 1) setMinGames(val);
          }}
          min={1}
          allowNegative={false}
          allowDecimal={false}
        />
      )}
    </Group>
  );
}
