import { Switch } from "@mantine/core";
import { type PrimitiveAtom, useAtom } from "jotai";
import { useContext } from "react";
import { useTranslation } from "react-i18next";
import { SettingLabelContext, SettingToggleContext } from "./SettingsLayout";

export default function SettingsSwitch({
  atom,
  label,
}: {
  atom: PrimitiveAtom<boolean>;
  label?: string;
}) {
  const { t } = useTranslation();
  const inheritedLabel = useContext(SettingLabelContext);
  const registerToggle = useContext(SettingToggleContext);
  const [checked, setChecked] = useAtom(atom);
  return (
    <Switch
      ref={registerToggle ?? undefined}
      aria-label={label || inheritedLabel}
      onLabel={t("Common.On")}
      offLabel={t("Common.Off")}
      size="lg"
      checked={checked}
      onChange={(event) => setChecked(event.currentTarget.checked)}
      styles={{
        track: { cursor: "pointer", pointerEvents: "none" },
        thumb: { pointerEvents: "none" },
      }}
    />
  );
}
