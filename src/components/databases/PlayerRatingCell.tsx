import { Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

function PlayerRatingCell({ name, elo }: { name: string; elo: number | null | undefined }) {
  const { t } = useTranslation();
  return (
    <div>
      <Text size="sm" fw={500}>
        {name}
      </Text>
      <Text size="xs" c="dimmed">
        {elo === 0 ? t("GameInfo.Unrated") : elo}
      </Text>
    </div>
  );
}

export default PlayerRatingCell;
