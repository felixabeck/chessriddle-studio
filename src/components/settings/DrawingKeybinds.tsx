import { Box, Group, Table, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { platform } from "@/platform/native";
import { DRAWING_MODIFIERS, type DrawingColor, pgnDrawingBrushes } from "@/utils/drawings";
import { KbdDisplay } from "./KeybindInput";

/** Read-only list of the right-click modifiers that pick a drawing colour. */
export function DrawingKeybinds({ titleClassName }: { titleClassName?: string }) {
  const { t } = useTranslation();
  // On macOS Ctrl+click opens the context menu, so Cmd is the documented Ctrl equivalent.
  const ctrl = platform() === "macos" ? "cmd" : "ctrl";
  const colorNames: Record<DrawingColor, string> = {
    green: t("Settings.Drawing.Green"),
    red: t("Settings.Drawing.Red"),
    blue: t("Settings.Drawing.Blue"),
    yellow: t("Settings.Drawing.Yellow"),
    orange: t("Settings.Drawing.Orange"),
    cyan: t("Settings.Drawing.Cyan"),
  };

  return (
    <>
      <Text size="lg" fw={500} className={titleClassName} mt="xl">
        {t("Settings.Drawing")}
      </Text>
      <Text size="xs" c="dimmed" mt={3} mb="lg">
        {t("Settings.Drawing.Desc")}
      </Text>
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t("Settings.Drawing.Color")}</Table.Th>
            <Table.Th>{t("Settings.Drawing.Mouse")}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {DRAWING_MODIFIERS.map(({ color, modifiers }) => {
            const keys = modifiers.map((key) => (key === "ctrl" ? ctrl : key));
            return (
              <Table.Tr key={color} data-testid={`drawing-color-${color}`}>
                <Table.Td>
                  <Group gap="xs">
                    <Box
                      w={14}
                      h={14}
                      style={{ borderRadius: "50%", background: pgnDrawingBrushes[color].color }}
                    />
                    {colorNames[color]}
                  </Group>
                </Table.Td>
                <Table.Td>
                  <KbdDisplay
                    keys={keys.join("+")}
                    hovering={false}
                    suffix={t("Settings.Drawing.RightClick")}
                  />
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </>
  );
}
