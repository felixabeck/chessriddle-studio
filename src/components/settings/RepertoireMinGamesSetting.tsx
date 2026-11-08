import { Group, NumberInput } from "@mantine/core";
import { useAtom } from "jotai";
import { useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
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

  useEffect(() => {
    setPreset(presetFor(minGames));
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
        <NumberInput
          w={100}
          aria-label={inheritedLabel}
          value={minGames}
          onChange={(val) => setMinGames(Number(val) || 50)}
          min={1}
          allowNegative={false}
          allowDecimal={false}
        />
      )}
    </Group>
  );
}
