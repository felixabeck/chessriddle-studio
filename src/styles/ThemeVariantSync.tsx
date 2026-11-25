import { useMantineColorScheme, useMantineTheme } from "@mantine/core";
import { useAtomValue } from "jotai";
import { useLayoutEffect, useMemo } from "react";
import { isDimActive, themeVariantAtom } from "@/state/atoms";
import { dimThemeCss } from "./theme";

/** Dim is a variant of dark: its overrides apply only while the explicit scheme is dark. */
export default function ThemeVariantSync() {
  const variant = useAtomValue(themeVariantAtom);
  const { colorScheme } = useMantineColorScheme();
  const theme = useMantineTheme();
  const dim = isDimActive(colorScheme, variant);
  useLayoutEffect(() => {
    if (dim) document.documentElement.setAttribute("data-cf-theme-variant", "dim");
    else document.documentElement.removeAttribute("data-cf-theme-variant");
  }, [dim]);
  const css = useMemo(() => dimThemeCss(theme), [theme]);
  return <style>{css}</style>;
}
