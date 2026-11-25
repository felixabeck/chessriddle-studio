import { Box, Flex } from "@mantine/core";
import { useAtom } from "jotai";
import { pieceSetAtom } from "@/state/atoms";
import { PIECE_SETS, type PieceSet } from "@/state/artworkCatalog";
import PieceComponent from "../common/Piece";
import SettingsSelect from "./SettingsSelect";

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
  const [pieceSet, setPieceSet] = useAtom(pieceSetAtom);

  return (
    <Flex justify="space-between" align="center" gap="md" wrap="wrap">
      <DisplayPieces />
      <SettingsSelect
        allowDeselect={false}
        data={PIECE_SETS.map((item) => ({
          value: item.value,
          label: item.label,
        }))}
        value={pieceSet}
        onPreview={(val) => setPieceSet(val as PieceSet)}
        onChange={(val) => {
          if (val == null) return;
          setPieceSet(val as PieceSet);
        }}
      />
    </Flex>
  );
}
