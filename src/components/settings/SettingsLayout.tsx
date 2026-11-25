import { Group, Text } from "@mantine/core";
import { createContext, type MouseEvent, type ReactNode, useRef, useState } from "react";
import classes from "./SettingsPage.module.css";

export const SettingLabelContext = createContext<string | undefined>(undefined);

/**
 * A row whose only control is an on/off switch hands that switch's input to the row, so a click
 * anywhere on the row flips it, as a label would. Rows with other controls never register one.
 */
export const SettingToggleContext = createContext<
  ((input: HTMLInputElement | null) => void) | null
>(null);

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
  const [toggleInput, setToggleInput] = useState<HTMLInputElement | null>(null);
  const controlRef = useRef<HTMLDivElement>(null);

  // Pointer convenience only: the switch itself stays the keyboard and screen-reader target.
  const handleRowClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!toggleInput) return;
    // The switch handles its own clicks, and those bubble up here too.
    if (controlRef.current?.contains(event.target as Node)) return;
    // Dragging across the description to select it is not a request to flip the setting.
    if (window.getSelection()?.isCollapsed === false) return;
    toggleInput.click();
  };

  return (
    <Group
      justify="space-between"
      gap="xl"
      className={classes.item}
      data-setting-id={id}
      data-highlighted={highlight || undefined}
      data-dependent={nested || undefined}
      data-toggle-row={toggleInput ? true : undefined}
      onClick={toggleInput ? handleRowClick : undefined}
    >
      <div className={classes.settingCopy}>
        <Text className={classes.settingTitle}>{title}</Text>
        <Text size="xs" c="dimmed">
          {description}
        </Text>
      </div>
      <div ref={controlRef} className={classes.settingControl} aria-label={title}>
        <SettingLabelContext.Provider value={title}>
          <SettingToggleContext.Provider value={setToggleInput}>
            {children}
          </SettingToggleContext.Provider>
        </SettingLabelContext.Provider>
      </div>
    </Group>
  );
}
