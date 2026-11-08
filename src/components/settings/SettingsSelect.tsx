import { Select, type SelectProps } from "@mantine/core";
import { useContext } from "react";
import { SettingLabelContext } from "./SettingsLayout";

export default function SettingsSelect(props: SelectProps) {
  const inheritedLabel = useContext(SettingLabelContext);
  return <Select aria-label={inheritedLabel} {...props} />;
}
