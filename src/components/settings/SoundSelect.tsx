import { Group, Text } from "@mantine/core";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { soundCollectionAtom } from "@/state/atoms";
import { SOUND_COLLECTIONS } from "@/state/preferenceSchemas";
import { playSound } from "@/utils/sound";
import { SettingsCombobox } from "./SettingsCombobox";

const soundCollectionLabels: Record<(typeof SOUND_COLLECTIONS)[number], string> = {
  futuristic: "Futuristic",
  lisp: "Lisp",
  nes: "NES",
  piano: "Piano",
  robot: "Robot",
  sfx: "SFX",
  standard: "Standard",
  woodland: "WoodLand",
};

function SelectOption({ label }: { label: string }) {
  return (
    <Group wrap="nowrap">
      <Text fz="sm" fw={500}>
        {label}
      </Text>
    </Group>
  );
}

export default function SoundSelect() {
  const { t } = useTranslation();
  const [soundCollection, setSoundCollection] = useAtom(soundCollectionAtom);

  return (
    <SettingsCombobox
      ariaLabel={t("Settings.Sound.Collection")}
      value={soundCollection}
      width="10rem"
      withinPortal
      data={SOUND_COLLECTIONS.map((value) => ({
        value,
        label: <SelectOption label={soundCollectionLabels[value]} />,
        preview: <SelectOption label={soundCollectionLabels[value]} />,
      }))}
      onCommit={(next) => {
        setSoundCollection(next);
        playSound(false, false);
      }}
    />
  );
}
