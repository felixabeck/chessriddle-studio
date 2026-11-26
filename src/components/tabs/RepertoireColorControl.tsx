import { SegmentedControl, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

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

  return (
    <div>
      <Text size="sm" fw={500} mb={4}>
        {t("Home.Card.NewRepertoire.Color")}
      </Text>
      <SegmentedControl
        fullWidth
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
