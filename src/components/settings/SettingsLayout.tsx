import { Group, Text } from "@mantine/core";
import { createContext, type ReactNode } from "react";
import classes from "./SettingsPage.module.css";

export const SettingLabelContext = createContext<string | undefined>(undefined);

export function SettingRow({
  id,
  title,
  description,
  children,
  highlight = false,
  nested = false,
}: {
  id?: string;
  title: string;
  description: string;
  children: ReactNode;
  highlight?: boolean;
  nested?: boolean;
}) {
  return (
    <Group
      justify="space-between"
      gap="xl"
      className={classes.item}
      data-setting-id={id}
      data-highlighted={highlight || undefined}
      data-dependent={nested || undefined}
    >
      <div className={classes.settingCopy}>
        <Text className={classes.settingTitle}>{title}</Text>
        <Text size="xs" c="dimmed">
          {description}
        </Text>
      </div>
      <div className={classes.settingControl} aria-label={title}>
        <SettingLabelContext.Provider value={title}>{children}</SettingLabelContext.Provider>
      </div>
    </Group>
  );
}
