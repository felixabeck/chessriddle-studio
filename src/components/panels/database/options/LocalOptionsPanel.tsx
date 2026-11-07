import { useTabAtom } from "@/state/tabScope";
import {
  Box,
  Button,
  Group,
  RangeSlider,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
} from "@mantine/core";
import { DateInput } from "@mantine/dates";
import { type Piece, parseSquare } from "chessops";
import { EMPTY_BOARD_FEN, makeFen, parseFen } from "chessops/fen";
import dayjs from "dayjs";
import { useAtom } from "jotai";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Chessground } from "@/chessground/Chessground";
import PiecesGrid from "@/components/boards/PiecesGrid";
import { PlayerSearchInput } from "@/components/databases/PlayerSearchInput";
import { localOptionsFamily } from "@/state/atoms";
import type { DatabaseHandle } from "@/bindings";
import { databaseHandleKey, ELO_FILTER_MAX, getEffectiveLocalPlayer } from "@/utils/db";

const YEAR_PRESETS = [1, 3, 5, 10];

function LocalOptionsPanel({
  boardFen,
  database,
}: {
  boardFen: string;
  database: DatabaseHandle | null;
}) {
  const { t } = useTranslation();
  const boardRef = useRef(null);
  const [options, setOptions] = useAtom(useTabAtom(localOptionsFamily));
  const databaseKey = database ? databaseHandleKey(database) : undefined;

  const setSimilarStructure = async (fen: string) => {
    const setup = parseFen(fen).unwrap();
    for (const square of setup.board.pawn.complement()) {
      setup.board.take(square);
    }
    const fenResult = makeFen(setup);
    setOptions((q) => ({ ...q, type: "partial", fen: fenResult }));
  };

  const [selectedPiece, setSelectedPiece] = useState<Piece | null>(null);
  const [eloDraft, setEloDraft] = useState<[number, number] | null>(null);

  return (
    <Stack>
      <SimpleGrid cols={2}>
        <Stack gap={4}>
          <Text fw="bold" fz="sm">
            {t("Board.Database.Local.Player")}
          </Text>
          {database && (
            <PlayerSearchInput
              key={databaseKey}
              label={t("Common.Search")}
              value={getEffectiveLocalPlayer(options, database) ?? undefined}
              file={database}
              setValue={(v) =>
                setOptions((q) => ({
                  ...q,
                  player: v ?? null,
                  player_database: v !== undefined ? databaseKey : undefined,
                }))
              }
            />
          )}
        </Stack>
        <Stack gap={4}>
          <Text fw="bold" fz="sm">
            {t("Board.Database.Local.Color")}
          </Text>
          <SegmentedControl
            data={[
              { value: "white", label: t("Fen.White") },
              { value: "black", label: t("Fen.Black") },
            ]}
            value={options.color}
            onChange={(v) => setOptions({ ...options, color: v as "white" | "black" })}
          />
        </Stack>

        <Stack gap={4}>
          <Text fw="bold" fz="sm">
            {t("Common.From")}
          </Text>
          <DateInput
            placeholder={t("Common.StartDate")}
            valueFormat="YYYY-MM-DD"
            clearable
            value={
              options.start_date ? dayjs(options.start_date, "YYYY.MM.DD").toDate() : undefined
            }
            onChange={(value) =>
              setOptions({
                ...options,
                start_date: value ? dayjs(value).format("YYYY.MM.DD") : undefined,
              })
            }
          />
          <Group gap={4}>
            {YEAR_PRESETS.map((years) => (
              <Button
                key={years}
                size="compact-xs"
                variant="default"
                onClick={() =>
                  // Rolling window from today; the To date is left as is.
                  setOptions((q) => ({
                    ...q,
                    start_date: dayjs().subtract(years, "year").format("YYYY.MM.DD"),
                  }))
                }
              >
                {t("Board.Database.Local.LastYears", { count: years })}
              </Button>
            ))}
          </Group>
        </Stack>
        <Stack gap={4}>
          <Text fw="bold" fz="sm">
            {t("Common.To")}
          </Text>
          <DateInput
            placeholder={t("Common.EndDate")}
            valueFormat="YYYY-MM-DD"
            clearable
            value={options.end_date ? dayjs(options.end_date, "YYYY.MM.DD").toDate() : null}
            onChange={(value) =>
              setOptions({
                ...options,
                end_date: value ? dayjs(value).format("YYYY.MM.DD") : undefined,
              })
            }
          />
        </Stack>

        <Stack gap={4}>
          <Text fw="bold" fz="sm">
            {t("Board.Database.Local.Result")}
          </Text>
          <Select
            data={[
              { value: "any", label: t("Board.Database.Local.Result.Any") },
              {
                value: "whitewon",
                label: t("Board.Database.Local.Result.WhiteWon"),
              },
              { value: "draw", label: t("Board.Analysis.Tablebase.Draw") },
              {
                value: "blackwon",
                label: t("Board.Database.Local.Result.BlackWon"),
              },
            ]}
            value={options.result}
            onChange={(v) =>
              setOptions({
                ...options,
                result: v as "any" | "whitewon" | "draw" | "blackwon",
              })
            }
          />
        </Stack>
      </SimpleGrid>

      <Stack gap={4}>
        <Text fw="bold" fz="sm">
          {t("Board.Database.Local.Elo")}
        </Text>
        <Text c="dimmed" fz="xs">
          {t("Board.Database.Local.Elo.BothPlayers")}
        </Text>
        <RangeSlider
          step={10}
          min={0}
          max={ELO_FILTER_MAX}
          marks={[
            { value: 1000, label: String(1000) },
            { value: 2000, label: String(2000) },
            { value: ELO_FILTER_MAX, label: String(ELO_FILTER_MAX) },
          ]}
          value={eloDraft ?? options.elo ?? [0, ELO_FILTER_MAX]}
          onChange={setEloDraft}
          onChangeEnd={(value) => {
            // Commit once per drag so the search does not rerun on every tick.
            setEloDraft(null);
            setOptions((q) => ({ ...q, elo: value }));
          }}
        />
      </Stack>

      <Switch
        // Mantine's label element also wraps the description; keep the accessible name to the label.
        aria-label={t("Board.Database.Local.ExcludeFastEvents")}
        label={t("Board.Database.Local.ExcludeFastEvents")}
        description={t("Board.Database.Local.ExcludeFastEvents.Description")}
        checked={options.exclude_fast_events ?? false}
        onChange={(event) => {
          const checked = event.currentTarget.checked;
          setOptions((q) => ({ ...q, exclude_fast_events: checked }));
        }}
      />

      <Stack gap={4}>
        <Text fw="bold" fz="sm">
          {t("Board.Database.Local.Position")}
        </Text>
        <SegmentedControl
          data={[
            { value: "exact", label: t("Board.Database.Local.Exact") },
            { value: "partial", label: t("Board.Database.Local.Partial") },
          ]}
          value={options.type}
          onChange={(v) => setOptions({ ...options, type: v as "exact" | "partial" })}
        />
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

export default LocalOptionsPanel;
