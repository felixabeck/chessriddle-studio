import { Box, Group } from "@mantine/core";
import { useAtom } from "jotai";
import { boardImageAtom } from "@/state/atoms";
import { BOARD_IMAGES, type BoardImage } from "@/state/artworkCatalog";
import SettingsSelect from "./SettingsSelect";

function boardName(image: string) {
  return image.split(".")[0];
}

function BoardThumbnail({ image }: { image: string }) {
  const file = image.endsWith(".svg") ? image : image.replace(".", ".thumbnail.");

  return (
    <Box
      style={{
        width: 64,
        height: 32,
        backgroundImage: `url(/board/${file})`,
        flexShrink: 0,
        backgroundSize: image.endsWith(".svg") ? 256 : undefined,
      }}
    />
  );
}

function setKnownBoard(value: string, setBoard: (image: BoardImage) => void) {
  if ((BOARD_IMAGES as readonly string[]).includes(value)) setBoard(value as BoardImage);
}

export default function BoardSelect() {
  const [board, setBoard] = useAtom(boardImageAtom);

  return (
    <SettingsSelect
      allowDeselect={false}
      data={BOARD_IMAGES.map((item) => ({
        value: item,
        label: boardName(item),
      }))}
      value={board}
      renderOption={({ option }) => (
        <Group wrap="nowrap" gap="xs" miw={0}>
          <BoardThumbnail image={option.value} />
          {option.label}
        </Group>
      )}
      onPreview={(val) => setKnownBoard(val, setBoard)}
      onChange={(val) => {
        if (val == null) return;
        setKnownBoard(val, setBoard);
      }}
    />
  );
}
