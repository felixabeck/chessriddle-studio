import { Box, Flex, Text } from "@mantine/core";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { pieceSetAtom } from "@/state/atoms";
import { PIECE_SETS, type PieceSet } from "@/state/artworkCatalog";
import PieceComponent from "../common/Piece";
import { SettingsCombobox } from "./SettingsCombobox";

function DisplayPieces() {
  const pieces = ["rook", "knight", "bishop", "queen", "king", "pawn"] as const;
  return (
    <Flex gap="xs" wrap="wrap">
      {pieces.map((role, index) => (
        <Box key={index} h="2.5rem" w="2.5rem">
          <PieceComponent piece={{ color: "white", role }} />
        </Box>
      ))}
    </Flex>
  );
}

export default function PiecesSelect() {
  const { t } = useTranslation();
  const [pieceSet, setPieceSet] = useAtom(pieceSetAtom);

  return (
    <Flex justify="space-between" align="center" gap="md" wrap="wrap">
      <DisplayPieces />
      <SettingsCombobox<PieceSet>
        ariaLabel={t("Settings.Appearance.PieceSet")}
        value={pieceSet}
        width="10rem"
        data={PIECE_SETS.map((item) => ({
          value: item.value,
          label: (
            <Text fz="sm" fw={500}>
              {item.label}
            </Text>
          ),
        }))}
        onPreview={setPieceSet}
        onCommit={setPieceSet}
      />
    </Flex>
  );
}
