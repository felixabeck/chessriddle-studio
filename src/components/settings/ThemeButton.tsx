import {
  Box,
  Center,
  type MantineColorScheme,
  SegmentedControl,
  useMantineColorScheme,
} from "@mantine/core";
import { useAtom } from "jotai";
import { Monitor, Moon, Sun, SunDim } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isDimActive, themeVariantAtom } from "@/state/atoms";

export default function ThemeButton() {
  const { t } = useTranslation();

  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const [variant, setVariant] = useAtom(themeVariantAtom);
  const value = isDimActive(colorScheme, variant) ? "dim" : colorScheme;

  return (
    <Box style={{ overflowX: "auto", maxWidth: "100%" }}>
      <SegmentedControl
        style={{ display: "flex", width: "max-content", marginInline: "auto" }}
        value={value}
        onChange={(next) => {
          if (next === "dim") {
            setColorScheme("dark");
            setVariant("dim");
            return;
          }
          if (next === "dark") {
            setColorScheme("dark");
            setVariant("default");
            return;
          }
          // Auto and Light keep the stored variant on purpose; it has no effect outside Dark, as in ChessRiddle web.
          setColorScheme(next as MantineColorScheme);
        }}
        data={[
          {
            value: "auto",
            label: (
              <Center>
                <Monitor size="1rem" strokeWidth={2} />
                <Box ml={10}>{t("Settings.Appearance.Theme.Auto")}</Box>
              </Center>
            ),
          },
          {
            value: "light",
            label: (
              <Center>
                <Sun size="1rem" strokeWidth={2} />
                <Box ml={10}>{t("Settings.Appearance.Theme.Light")}</Box>
              </Center>
            ),
          },
          {
            value: "dark",
            label: (
              <Center>
                <Moon size="1rem" strokeWidth={2} />
                <Box ml={10}>{t("Settings.Appearance.Theme.Dark")}</Box>
              </Center>
            ),
          },
          {
            value: "dim",
            label: (
              <Center>
                <SunDim size="1rem" strokeWidth={2} />
                <Box ml={10}>{t("Settings.Appearance.Theme.Dim")}</Box>
              </Center>
            ),
          },
        ]}
      />
    </Box>
  );
}
