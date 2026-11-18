import { Badge, Box } from "@mantine/core";
import { Crosshair } from "lucide-react";
import { useTranslation } from "react-i18next";
import ExplainedAction from "@/components/library/ExplainedAction";

/**
 * Marks engine output searched in threat mode, where the side to move passes and the lines and
 * evaluations show the opponent's next move instead of the position's own evaluation. Every
 * surface that shows engine lines uses this one marker.
 */
export function ThreatBadge({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const label = t("Board.Analysis.ThreatMode");
  return (
    <ExplainedAction explanation={t("Board.Analysis.ThreatModeHint")}>
      {compact ? (
        <Box
          component="span"
          role="img"
          aria-label={label}
          data-testid="threat-badge"
          display="inline-flex"
          c="var(--cf-destructive)"
          style={{ flexShrink: 0 }}
        >
          <Crosshair size="0.875rem" aria-hidden />
        </Box>
      ) : (
        <Badge
          color="danger"
          variant="light"
          size="sm"
          data-testid="threat-badge"
          leftSection={<Crosshair size="0.75rem" aria-hidden />}
          style={{ flexShrink: 0 }}
        >
          {label}
        </Badge>
      )}
    </ExplainedAction>
  );
}
