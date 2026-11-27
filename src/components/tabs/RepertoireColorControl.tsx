import { useRootFontPx } from "@/hooks/useRootFontPx";
import { SegmentedControl, Text } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { useTranslation } from "react-i18next";
import classes from "./RepertoireColorControl.module.css";

const COLOR_CONTROL_MIN_WIDTH_REM = 14;

/** Shared White/Black colour selector for repertoire creation and import dialogs. */
export function RepertoireColorControl({
  value,
  onChange,
  disabled = false,
}: {
  value: "white" | "black";
  onChange: (value: "white" | "black") => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const { ref, width } = useElementSize();
  const rootFont = useRootFontPx();

  return (
    <div ref={ref} className={classes.container}>
      <Text size="sm" fw={500} mb={4}>
        {t("Home.Card.NewRepertoire.Color")}
      </Text>
      <SegmentedControl
        fullWidth
        orientation={width >= COLOR_CONTROL_MIN_WIDTH_REM * rootFont ? "horizontal" : "vertical"}
        className={classes.control}
        value={value}
        disabled={disabled}
        onChange={(v) => onChange(v as "white" | "black")}
        data={[
          { label: t("Common.WHITE"), value: "white" },
          { label: t("Common.BLACK"), value: "black" },
        ]}
      />
    </div>
  );
}
