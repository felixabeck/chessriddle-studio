import { Table } from "@mantine/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DataTableProps } from "mantine-datatable";
import { type RefObject, useCallback, useEffect, useMemo, useRef } from "react";

/** Default estimated row height in pixels before ResizeObserver measures rendered rows. */
export const DEFAULT_ROW_HEIGHT_ESTIMATE = 37;
const DEFAULT_WINDOW_OVERSCAN = 10;
/**
 * Fixed slice rendered from the top when the scroll viewport has not been measured yet
 * (initial render, hidden `keepMounted` tabs, jsdom). Enough to fill a tall window without
 * ever rendering zero rows or the entire loaded list.
 */
export const INITIAL_WINDOW_ROWS = 40;

function renderSpacerRow(position: "top" | "bottom", height: number) {
  return (
    <tr
      aria-hidden="true"
      data-virtual-spacer={position}
      style={{
        height,
        pointerEvents: "none",
        background: "transparent",
      }}
    >
      <td style={{ height, padding: 0, border: 0 }} />
    </tr>
  );
}

export type WindowedTableRowsResult<R> = {
  visibleRecords: R[];
  rowFactory: DataTableProps<R>["rowFactory"];
  scrollToIndex: (index: number) => void;
};

/**
 * Shared row-windowing owner for the Library database tables and the tournament card's game list.
 *
 * When `enabled` is true ("All" mode), slices `records` to the rows in and near `scrollViewportRef`
 * via `@tanstack/react-virtual` and inserts top/bottom spacer rows through `DataTable`'s
 * `rowFactory` so the table height and scrollbar span every loaded row. When `enabled` is false
 * (paged mode), passes `records` through untouched with no `rowFactory`.
 */
export function useWindowedTableRows<R>({
  records,
  enabled,
  scrollViewportRef,
}: {
  records: R[];
  enabled: boolean;
  scrollViewportRef: RefObject<HTMLDivElement | null>;
}): WindowedTableRowsResult<R> {
  const virtualizer = useVirtualizer({
    count: enabled ? records.length : 0,
    getScrollElement: () => scrollViewportRef.current,
    estimateSize: () => DEFAULT_ROW_HEIGHT_ESTIMATE,
    // A hidden keepMounted tab (display: none) or unmeasured test DOM reports 0 height; keep the
    // estimate instead of poisoning the row-height cache with 0px entries.
    measureElement: (element) => {
      const height = element.getBoundingClientRect().height;
      return height > 0 ? height : DEFAULT_ROW_HEIGHT_ESTIMATE;
    },
    overscan: DEFAULT_WINDOW_OVERSCAN,
    useFlushSync: false,
  });

  // Re-read viewport geometry and drop stale row measurements when switching back into "All" mode.
  const wasEnabledRef = useRef(enabled);
  useEffect(() => {
    const wasEnabled = wasEnabledRef.current;
    wasEnabledRef.current = enabled;
    if (enabled && !wasEnabled) virtualizer.measure();
  }, [enabled, virtualizer]);

  const virtualItems = enabled ? virtualizer.getVirtualItems() : [];
  const rawTotalSize = enabled ? virtualizer.getTotalSize() : 0;

  let startIndex = 0;
  let visibleRecords: R[] = records;
  let topSpacerHeight = 0;
  let bottomSpacerHeight = 0;

  if (enabled) {
    if (records.length === 0) {
      visibleRecords = [];
    } else if (virtualItems.length > 0) {
      startIndex = virtualItems[0].index;
      const endIndex = virtualItems[virtualItems.length - 1].index;
      visibleRecords = records.slice(startIndex, endIndex + 1);
      topSpacerHeight = virtualItems[0].start;
      bottomSpacerHeight = Math.max(0, rawTotalSize - virtualItems[virtualItems.length - 1].end);
    } else {
      const sliceCount = Math.min(records.length, INITIAL_WINDOW_ROWS);
      startIndex = 0;
      visibleRecords = records.slice(0, sliceCount);
      topSpacerHeight = 0;
      const fallbackTotalSize = Math.max(
        rawTotalSize,
        records.length * DEFAULT_ROW_HEIGHT_ESTIMATE,
      );
      bottomSpacerHeight = Math.max(
        0,
        fallbackTotalSize - sliceCount * DEFAULT_ROW_HEIGHT_ESTIMATE,
      );
    }
  }

  const scrollToIndex = useCallback(
    (index: number) => {
      if (!enabled || index < 0 || index >= records.length) return;
      const viewport = scrollViewportRef.current;
      if (!viewport) return;
      const headerHeight = viewport.querySelector("thead")?.getBoundingClientRect().height ?? 0;
      const item = virtualizer.measurementsCache[index];
      if (!item || viewport.clientHeight <= 0) {
        if (typeof viewport.scrollTo === "function") {
          virtualizer.scrollToIndex(index, { align: "auto" });
        }
        return;
      }
      const visibleBodyHeight = Math.max(0, viewport.clientHeight - headerHeight);
      const viewTop = viewport.scrollTop;
      const viewBottom = viewTop + visibleBodyHeight;
      let targetOffset: number | null = null;
      if (item.start < viewTop) {
        targetOffset = item.start;
      } else if (item.end > viewBottom) {
        targetOffset = Math.max(0, item.end - visibleBodyHeight);
      }
      if (targetOffset !== null) {
        if (typeof viewport.scrollTo === "function") {
          virtualizer.scrollToOffset(targetOffset);
        } else {
          viewport.scrollTop = targetOffset;
        }
      }
    },
    [enabled, records.length, scrollViewportRef, virtualizer],
  );

  const visibleCount = visibleRecords.length;
  const rowFactory = useMemo<DataTableProps<R>["rowFactory"]>(() => {
    if (!enabled) return undefined;
    return ({ index, rowProps, children, expandedElement }) => (
      <>
        {index === 0 && topSpacerHeight > 0 && renderSpacerRow("top", topSpacerHeight)}
        <Table.Tr {...rowProps} ref={virtualizer.measureElement} data-index={startIndex + index}>
          {children}
        </Table.Tr>
        {expandedElement}
        {index === visibleCount - 1 &&
          bottomSpacerHeight > 0 &&
          renderSpacerRow("bottom", bottomSpacerHeight)}
      </>
    );
  }, [enabled, topSpacerHeight, bottomSpacerHeight, startIndex, visibleCount, virtualizer]);

  return {
    visibleRecords,
    rowFactory,
    scrollToIndex,
  };
}
