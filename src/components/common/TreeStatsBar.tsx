import { Group, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { isTreeViewDeferred, useTreeView } from "@/state/deferredTreeView";
import type { TreeStore } from "@/state/store/tree";
import { getStats } from "@/utils/repertoire";

const DEFERRED_STATS = { total: 0, leafs: 0, depth: 0 };

// While a file install defers the view, skip the tree walk; release re-renders with real counts.
export function useTreeStats(store: TreeStore) {
  const view = useTreeView(store);
  return isTreeViewDeferred(store) ? DEFERRED_STATS : getStats(view);
}

export function TreeStatsBar({ store }: { store: TreeStore }) {
  const { t } = useTranslation();
  const stats = useTreeStats(store);
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
    </Group>
  );
}
