import { Box, Button, Group, Image, Paper, Text } from "@mantine/core";
import { Gauge, HardDriveDownload } from "lucide-react";
import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import type { DefaultEngine } from "@/utils/engines";
import { formatBytes } from "@/utils/format";
import ProgressButton from "../common/ProgressButton";

// Padding yields to usable action width. The larger preferred text column basis makes
// the portrait/text row wrap before that reserve comes under pressure. Both use rem to follow font scale.
const ACTION_WIDTH_RESERVE = "10rem";
const PREFERRED_TEXT_COLUMN_BASIS = "12rem";

type Props = Omit<
  ComponentProps<typeof ProgressButton>,
  "id" | "completeOnProgressSuccess" | "clearOnCancel" | "leftIcon" | "redoable"
> & {
  engine: DefaultEngine;
  progressId: string | null;
  layout: "add" | "upgrade";
  recovery?: { busy: boolean; retry: () => void };
};

export default function CatalogEngineCard({
  engine,
  progressId,
  layout,
  recovery,
  ...progressProps
}: Props) {
  const { t } = useTranslation();
  const adding = layout === "add";

  return (
    <Paper withBorder radius="md" p={0}>
      <Group wrap="wrap" gap={0}>
        {engine.imageUrl && (
          <Box w={adding ? "1.75rem" : "4rem"} px="xs" style={{ flexShrink: 0 }}>
            <Image src={engine.imageUrl} alt={engine.name} fit="contain" />
          </Box>
        )}
        <Box
          p={`clamp(0px, calc((100% - ${ACTION_WIDTH_RESERVE}) / 2), var(--mantine-spacing-sm))`}
          flex={`1 1 ${PREFERRED_TEXT_COLUMN_BASIS}`}
          miw={0}
        >
          <Text tt="uppercase" c="dimmed" fw={700} size="xs">
            {t("Common.Engine")}
          </Text>
          <Text fw="bold" size="sm" mb="xs">
            {engine.name} {engine.version}
          </Text>
          <Group wrap="nowrap" gap="xs" fz={adding ? "xs" : undefined}>
            <Gauge size="1rem" />
            <Text size="xs">{`${engine.elo} ELO`}</Text>
          </Group>
          <Group wrap="nowrap" gap="xs" mb="xs" fz={adding ? "xs" : undefined}>
            <HardDriveDownload size="1rem" />
            <Text size="xs">{formatBytes(engine.downloadSize ?? 0)}</Text>
          </Group>
          {recovery ? (
            <Button
              className="wrap-button"
              fullWidth
              disabled={recovery.busy}
              onClick={recovery.retry}
            >
              {t(recovery.busy ? "Common.Extracting" : "Common.Install")}
            </Button>
          ) : (
            progressId && (
              <ProgressButton
                {...progressProps}
                id={progressId}
                completeOnProgressSuccess={false}
                clearOnCancel={false}
              />
            )
          )}
        </Box>
      </Group>
    </Paper>
  );
}
