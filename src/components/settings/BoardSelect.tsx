import { Box, Group, Text } from "@mantine/core";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { boardImageAtom } from "@/state/atoms";
import { BOARD_IMAGES } from "@/state/artworkCatalog";
import { SettingsCombobox } from "./SettingsCombobox";

function SelectOption({ label }: { label: string }) {
  let image = label;
  if (!label.endsWith(".svg")) {
    image = label.replace(".", ".thumbnail.");
  }

  return (
    <Group wrap="nowrap" miw={0}>
      <Box
        style={{
          width: "64px",
          height: "32px",
          backgroundImage: `url(/board/${image})`,
          flexShrink: 0,
          backgroundSize: label.endsWith(".svg") ? "256px" : undefined,
        }}
      />
      {/* Ellipsis without `truncate`, whose overflow: hidden would also cut descenders. */}
      <Text
        fz="sm"
        fw={500}
        miw={0}
        style={{
          overflowX: "clip",
          overflowY: "visible",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          // Room for a glyph's ink overhang (the tail of a "g"), which the clip would trim.
          paddingInline: 2,
          marginInline: -2,
        }}
      >
        {label.split(".")[0]}
      </Text>
    </Group>
  );
}

export default function BoardSelect() {
  const { t } = useTranslation();
  const [board, setBoard] = useAtom(boardImageAtom);

  return (
    <SettingsCombobox
      ariaLabel={t("Settings.Appearance.BoardImage")}
      value={board}
      data={BOARD_IMAGES.map((item) => ({
        value: item,
        label: <SelectOption label={item} />,
        preview: <SelectOption label={item} />,
      }))}
      onCommit={setBoard}
    />
  );
}
