import { useAtom } from "jotai";
import { soundCollectionAtom } from "@/state/atoms";
import { SOUND_COLLECTIONS } from "@/state/preferenceSchemas";
import { playSound } from "@/utils/sound";
import SettingsSelect from "./SettingsSelect";

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

export default function SoundSelect() {
  const [soundCollection, setSoundCollection] = useAtom(soundCollectionAtom);

  return (
    <SettingsSelect
      allowDeselect={false}
      data={SOUND_COLLECTIONS.map((value) => ({
        value,
        label: soundCollectionLabels[value],
      }))}
      value={soundCollection}
      onChange={(val) => {
        if (val == null) return;
        setSoundCollection(val);
        playSound(false, false);
      }}
    />
  );
}
