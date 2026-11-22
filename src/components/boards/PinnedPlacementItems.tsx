import { Box, Menu } from "@mantine/core";
import { Check } from "lucide-react";
import { useContext } from "react";
import { useTranslation } from "react-i18next";
import { PINNED_PLACEMENTS, type PinnedPlacement } from "@/state/atoms";
import { BoardLayoutModeContext } from "@/state/paneLayout";

/**
 * The places a pinned panel can sit, as menu entries in layout order. `current` is marked; null
 * marks none (a panel that is not pinned yet). Choosing the current place calls nothing.
 */
export function PinnedPlacementItems({
  current,
  onChoose,
}: {
  current: PinnedPlacement | null;
  onChoose: (placement: PinnedPlacement) => void;
}) {
  const { t } = useTranslation();
  // Beside the notation, the place above the tabs spans the notation too.
  const panelsBeside = useContext(BoardLayoutModeContext) === "beside";
  const labels: Record<PinnedPlacement, string> = {
    tabs: panelsBeside ? t("Pinned.AboveNotationAndTabs") : t("Pinned.AboveTabs"),
    notation: t("Pinned.AboveNotation"),
    belowNotation: t("Pinned.BelowNotation"),
    board: t("Pinned.BelowBoard"),
  };
  return PINNED_PLACEMENTS.map((placement) => (
    <Menu.Item
      key={placement}
      aria-current={placement === current || undefined}
      leftSection={
        placement === current ? <Check size="0.875rem" /> : <Box w="0.875rem" aria-hidden />
      }
      onClick={() => {
        if (placement !== current) onChoose(placement);
      }}
    >
      {labels[placement]}
    </Menu.Item>
  ));
}
