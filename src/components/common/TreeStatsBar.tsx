import { Group, Text, UnstyledButton } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { isTreeViewDeferred, useTreeView } from "@/state/deferredTreeView";
import type { TreeStore } from "@/state/store/tree";
import { getStats } from "@/utils/repertoire";
import { releasePointerFocus } from "./MoveCell";
import { useGoToNextOpenVariation } from "./TreeStateContext";

const DEFERRED_STATS = { total: 0, leafs: 0, depth: 0, openVariations: 0 };

// While a file install defers the view, skip the tree walk; release re-renders with real counts.
export function useTreeStats(store: TreeStore) {
  const view = useTreeView(store);
  return isTreeViewDeferred(store) ? DEFERRED_STATS : getStats(view);
}

export function TreeStatsBar({ store }: { store: TreeStore }) {
  const { t } = useTranslation();
  const stats = useTreeStats(store);
  const goToNextOpenVariation = useGoToNextOpenVariation(store);
  const openVariationsLabel = `${t("TreeStats.OpenVariations")}: ${stats.openVariations}`;
  return (
    <Group gap="md">
      <Text fz="xs" c="dimmed">
        {t("TreeStats.Variations")}: {stats.leafs}
      </Text>
      <Text fz="xs" c="dimmed">
        {t("TreeStats.MaxDepth")}: {stats.depth}
      </Text>
      <Text fz="xs" c="dimmed">
        {t("TreeStats.TotalMoves")}: {stats.total}
      </Text>
      {stats.openVariations > 0 ? (
        // Something is left to do, so the entry is a control in the open-variation mark's colour.
        <UnstyledButton
          fz="xs"
          c="var(--cf-open-variation)"
          td="underline"
          title={t("TreeStats.NextOpenVariation")}
          onClick={(event) => {
            // The jump moves the game elsewhere; a later key press must not ring this control.
            releasePointerFocus(event);
            goToNextOpenVariation();
          }}
        >
          {openVariationsLabel}
        </UnstyledButton>
      ) : (
        <Text fz="xs" c="dimmed">
          {openVariationsLabel}
        </Text>
      )}
    </Group>
  );
}
