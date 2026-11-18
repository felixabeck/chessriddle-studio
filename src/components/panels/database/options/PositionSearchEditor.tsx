import { useTabAtom } from "@/state/tabScope";
import { Box, Button, Group, SegmentedControl, Stack, Text } from "@mantine/core";
import { type Piece, parseSquare } from "chessops";
import { EMPTY_BOARD_FEN, makeFen, parseFen } from "chessops/fen";
import { useAtom } from "jotai";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Chessground } from "@/chessground/Chessground";
import PiecesGrid from "@/components/boards/PiecesGrid";
import { localOptionsFamily } from "@/state/atoms";

/** The tab's searched position and its exact or partial match mode, for every local source. */
function PositionSearchEditor({ boardFen }: { boardFen: string }) {
  const { t } = useTranslation();
  const boardRef = useRef(null);
  const [options, setOptions] = useAtom(useTabAtom(localOptionsFamily));

  const setSimilarStructure = async (fen: string) => {
    const setup = parseFen(fen).unwrap();
    for (const square of setup.board.pawn.complement()) {
      setup.board.take(square);
    }
    const fenResult = makeFen(setup);
    setOptions((q) => ({ ...q, type: "partial", fen: fenResult }));
  };

  const [selectedPiece, setSelectedPiece] = useState<Piece | null>(null);

  return (
    <Stack pt="sm">
      <Stack gap={4}>
        <SegmentedControl
          aria-label={t("Board.Database.Local.Position")}
          data={[
            { value: "exact", label: t("Board.Database.Local.Exact") },
            { value: "partial", label: t("Board.Database.Local.Partial") },
          ]}
          value={options.type}
          onChange={(v) => setOptions({ ...options, type: v as "exact" | "partial" })}
        />
        <Text c="dimmed" fz="xs">
          {options.type === "partial"
            ? t("Board.Database.Local.Partial.Hint")
            : t("Board.Database.Local.Exact.Hint")}
        </Text>
      </Stack>

      <Group>
        <Stack>
          <Box ref={boardRef}>
            <Chessground
              fen={options.fen}
              coordinates={false}
              lastMove={[]}
              movable={{
                free: true,
                color: "both",
                events: {
                  after: (orig, dest) => {
                    const setup = parseFen(options.fen).unwrap();
                    const p = setup.board.take(parseSquare(orig)!)!;
                    setup.board.set(parseSquare(dest)!, p);
                    setOptions((q) => ({ ...q, fen: makeFen(setup) }));
                  },
                },
              }}
              events={{
                select: (key) => {
                  const square = parseSquare(key);
                  if (square && selectedPiece) {
                    const setup = parseFen(options.fen).unwrap();
                    setup.board.set(square, selectedPiece);
                    setOptions((q) => ({ ...q, fen: makeFen(setup) }));
                  }
                },
              }}
            />
          </Box>

          <Group>
            <Button
              variant="default"
              onClick={() => {
                setOptions((q) => ({ ...q, type: "exact", fen: boardFen }));
              }}
            >
              {t("Board.Database.Local.CurrentPosition")}
            </Button>
            <Button
              variant="default"
              onClick={() => {
                setSimilarStructure(boardFen);
              }}
            >
              {t("Board.Database.Local.SimilarStructure")}
            </Button>
            <Button
              variant="default"
              onClick={() => {
                setOptions((q) => ({
                  ...q,
                  type: "partial",
                  fen: EMPTY_BOARD_FEN,
                }));
              }}
            >
              {t("Fen.Empty")}
            </Button>
          </Group>
        </Stack>

        <Box flex={1} style={{ display: "flex", flexDirection: "column" }} h="30rem">
          <PiecesGrid
            boardRef={boardRef}
            fen={options.fen}
            vertical
            onPut={(newFen) => {
              setOptions((q) => ({ ...q, fen: newFen }));
            }}
            onSelectPiece={setSelectedPiece}
            selectedPiece={selectedPiece}
          />
        </Box>
      </Group>
    </Stack>
  );
}

export default PositionSearchEditor;
