import { MantineProvider, Table } from "@mantine/core";
import { act, useLayoutEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import {
  DEFAULT_ROW_HEIGHT_ESTIMATE,
  INITIAL_WINDOW_ROWS,
  useWindowedTableRows,
  type WindowedTableRowsResult,
} from "./useWindowedTableRows";

type Row = { id: number; label: string };

function makeRows(count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    label: `Row ${index + 1}`,
  }));
}

installMatchMediaStub();

const resizeObservers = new Map<Element, ResizeObserverCallback>();
const originalResizeObserver = globalThis.ResizeObserver;

let host: HTMLDivElement;
let root: Root;
let latest: WindowedTableRowsResult<Row>;
let viewportNode: HTMLDivElement | null = null;
let stubRowHeight = 0;

function readSpacerHeight(position: "top" | "bottom"): number {
  const spacer = host.querySelector<HTMLTableRowElement>(`[data-virtual-spacer="${position}"]`);
  return spacer ? Number.parseFloat(spacer.style.height) : 0;
}

function setViewportMetrics(
  node: HTMLDivElement,
  {
    clientHeight,
    scrollHeight,
    scrollTop = 0,
    headerHeight = 0,
    suppressScrollEvent = false,
    omitScrollTo = false,
  }: {
    clientHeight: number;
    scrollHeight: number;
    scrollTop?: number;
    headerHeight?: number;
    suppressScrollEvent?: boolean;
    omitScrollTo?: boolean;
  },
) {
  let currentScrollTop = scrollTop;
  Object.defineProperty(node, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  });
  Object.defineProperty(node, "offsetHeight", {
    configurable: true,
    get: () => clientHeight,
  });
  Object.defineProperty(node, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(node, "scrollTop", {
    configurable: true,
    get: () => currentScrollTop,
    set: (value: number) => {
      currentScrollTop = value;
    },
  });
  node.getBoundingClientRect = () =>
    ({
      width: 600,
      height: clientHeight,
      top: 0,
      left: 0,
      bottom: clientHeight,
      right: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  node.scrollTo = omitScrollTo
    ? (undefined as never)
    : (((optionsOrX?: ScrollToOptions | number, y?: number) => {
        const nextTop = typeof optionsOrX === "number" ? (y ?? 0) : (optionsOrX?.top ?? 0);
        currentScrollTop = nextTop;
        if (!suppressScrollEvent) {
          node.dispatchEvent(new Event("scroll"));
        }
      }) as typeof node.scrollTo);

  const thead = node.querySelector("thead");
  if (thead) {
    thead.getBoundingClientRect = () =>
      ({
        width: 600,
        height: headerHeight,
        top: 0,
        left: 0,
        bottom: headerHeight,
        right: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
  }
}

function Probe({
  records,
  enabled,
  viewportHeight,
  headerHeight = 0,
  resetKey,
  suppressScrollEvent = false,
  omitScrollTo = false,
}: {
  records: Row[];
  enabled: boolean;
  viewportHeight: number;
  headerHeight?: number;
  resetKey?: string;
  suppressScrollEvent?: boolean;
  omitScrollTo?: boolean;
}) {
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const node = scrollViewportRef.current;
    viewportNode = node;
    if (node) {
      setViewportMetrics(node, {
        clientHeight: viewportHeight,
        scrollHeight:
          headerHeight + records.length * Math.max(DEFAULT_ROW_HEIGHT_ESTIMATE, stubRowHeight),
        scrollTop: node.scrollTop || 0,
        headerHeight,
        suppressScrollEvent,
        omitScrollTo,
      });
    }
  }, [viewportHeight, headerHeight, records.length, suppressScrollEvent, omitScrollTo]);

  const windowing = useWindowedTableRows({
    records,
    enabled,
    scrollViewportRef,
    ...(resetKey !== undefined ? { resetKey } : {}),
  });
  latest = windowing;

  return (
    <div data-testid="viewport" ref={scrollViewportRef}>
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Label</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {windowing.visibleRecords.map((record, index) => {
            const children = <Table.Td>{record.label}</Table.Td>;
            if (windowing.rowFactory) {
              return (
                <RowSlot
                  key={record.id}
                  node={windowing.rowFactory({
                    record,
                    index,
                    children,
                    rowProps: { "data-row-id": String(record.id) } as never,
                  })}
                />
              );
            }
            return (
              <Table.Tr key={record.id} data-row-id={String(record.id)}>
                {children}
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </div>
  );
}

function RowSlot({ node }: { node: React.ReactNode }) {
  return <>{node}</>;
}

async function mount(props: Parameters<typeof Probe>[0]) {
  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <Probe {...props} />
      </MantineProvider>,
    );
  });
  if (viewportNode && props.viewportHeight > 0) {
    const callback = resizeObservers.get(viewportNode);
    if (callback) {
      await act(async () => {
        callback(
          [
            {
              target: viewportNode!,
              contentRect: { width: 600, height: props.viewportHeight },
              borderBoxSize: [{ inlineSize: 600, blockSize: props.viewportHeight }],
            } as unknown as ResizeObserverEntry,
          ],
          {} as ResizeObserver,
        );
      });
    }
  }
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resizeObservers.clear();
  viewportNode = null;
  stubRowHeight = 0;
  vi.spyOn(HTMLTableRowElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
    width: 600,
    height: stubRowHeight,
    top: 0,
    left: 0,
    bottom: stubRowHeight,
    right: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }));
  globalThis.ResizeObserver = class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      resizeObservers.set(target, this.callback);
    }
    unobserve(target: Element) {
      resizeObservers.delete(target);
    }
    disconnect() {
      for (const [target, callback] of resizeObservers) {
        if (callback === this.callback) resizeObservers.delete(target);
      }
    }
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  // Let any in-flight @tanstack/virtual-core scrollToIndex rAF settle before unmount clears targetWindow.
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  globalThis.ResizeObserver = originalResizeObserver;
  vi.unstubAllGlobals();
});

test("renders far fewer rows than loaded, sums spacers to the full height, and moves the window on scroll", async () => {
  const records = makeRows(500);
  const rowHeight = DEFAULT_ROW_HEIGHT_ESTIMATE;
  await mount({ records, enabled: true, viewportHeight: 370 });

  // 370px viewport / 37px row = 10 visible + 10 overscan below = ~20 rows, far fewer than 500.
  expect(latest.visibleRecords.length).toBeGreaterThan(0);
  expect(latest.visibleRecords.length).toBeLessThan(35);
  expect(host.querySelectorAll("tbody tr[data-row-id]")).toHaveLength(latest.visibleRecords.length);
  expect(readSpacerHeight("top")).toBe(0);
  expect(
    readSpacerHeight("top") + latest.visibleRecords.length * rowHeight + readSpacerHeight("bottom"),
  ).toBe(records.length * rowHeight);
  expect(host.querySelector('[data-virtual-spacer="top"]')).toBeNull();
  expect(host.querySelector('[data-virtual-spacer="bottom"]')).not.toBeNull();

  // Scroll down to row 200 (200 * 37 = 7400px): window moves, both spacers sum to full height.
  await act(async () => {
    viewportNode!.scrollTop = 200 * rowHeight;
    viewportNode!.dispatchEvent(new Event("scroll"));
  });

  const firstRenderedId = Number(
    host.querySelector<HTMLTableRowElement>("tbody tr[data-row-id]")!.dataset.rowId,
  );
  expect(firstRenderedId).toBeGreaterThan(180);
  expect(firstRenderedId).toBeLessThanOrEqual(201);
  expect(latest.visibleRecords.length).toBeLessThan(35);
  expect(readSpacerHeight("top")).toBeGreaterThan(0);
  expect(readSpacerHeight("bottom")).toBeGreaterThan(0);
  expect(
    readSpacerHeight("top") + latest.visibleRecords.length * rowHeight + readSpacerHeight("bottom"),
  ).toBe(records.length * rowHeight);
});

test("unmeasured viewport renders a fixed initial slice from the top, never zero and never all rows", async () => {
  const records = makeRows(500);
  await mount({ records, enabled: true, viewportHeight: 0 });

  expect(latest.visibleRecords).toHaveLength(INITIAL_WINDOW_ROWS);
  expect(latest.visibleRecords[0].id).toBe(1);
  expect(readSpacerHeight("top")).toBe(0);
  expect(readSpacerHeight("bottom")).toBe(
    (records.length - INITIAL_WINDOW_ROWS) * DEFAULT_ROW_HEIGHT_ESTIMATE,
  );
  expect(host.querySelectorAll("tbody tr[data-row-id]")).toHaveLength(INITIAL_WINDOW_ROWS);
});

test("scrollToIndex scrolls a row beyond the window into view, accounting for the sticky header", async () => {
  const records = makeRows(500);
  const rowHeight = DEFAULT_ROW_HEIGHT_ESTIMATE;
  // Viewport 410px with 40px sticky thead -> 370px visible body (10 rows of 37px).
  await mount({ records, enabled: true, viewportHeight: 410, headerHeight: 40 });

  expect(viewportNode!.scrollTop).toBe(0);

  // Index 100 (start=3700, end=3737) is below visible body [0, 370] -> scrolls to 3737 - 370 = 3367.
  // Flush a re-render and rAF verification frames to ensure scrollPaddingEnd is preserved across renders.
  await act(async () => {
    latest.scrollToIndex(100);
  });
  await mount({ records, enabled: true, viewportHeight: 410, headerHeight: 40 });
  await act(async () => {
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  });
  expect(viewportNode!.scrollTop).toBe(101 * rowHeight - 370);
  expect(latest.visibleRecords.some((row) => row.id === 101)).toBe(true);

  // Index 10 (start=370) is above current viewTop -> scrolls up to 370 (flush under sticky thead).
  await act(async () => {
    latest.scrollToIndex(10);
  });
  await mount({ records, enabled: true, viewportHeight: 410, headerHeight: 40 });
  await act(async () => {
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  });
  expect(viewportNode!.scrollTop).toBe(10 * rowHeight);
  expect(latest.visibleRecords.some((row) => row.id === 11)).toBe(true);
});

test("measureElement keeps the estimate on 0px rows and uses positive measured heights", async () => {
  const records = makeRows(500);
  const rowHeight = DEFAULT_ROW_HEIGHT_ESTIMATE;

  // 0px row rects (hidden tab / unmeasured DOM) must not poison cached row heights with 0.
  stubRowHeight = 0;
  await mount({ records, enabled: true, viewportHeight: 370 });
  const initialCount = latest.visibleRecords.length;
  expect(readSpacerHeight("bottom")).toBe((records.length - initialCount) * rowHeight);

  // Scroll past the initially rendered rows: top spacer still reflects DEFAULT_ROW_HEIGHT_ESTIMATE.
  await act(async () => {
    viewportNode!.scrollTop = 100 * rowHeight;
    viewportNode!.dispatchEvent(new Event("scroll"));
  });
  const firstIdAfterZero = Number(
    host.querySelector<HTMLTableRowElement>("tbody tr[data-row-id]")!.dataset.rowId,
  );
  expect(readSpacerHeight("top")).toBe((firstIdAfterZero - 1) * rowHeight);

  // Positive measured row height (60px) is recorded for the initial slice and increases the spacer height.
  await act(async () => root.unmount());
  root = createRoot(host);
  stubRowHeight = 60;
  await mount({ records, enabled: true, viewportHeight: 370 });
  await act(async () => {
    viewportNode!.scrollTop = 100 * rowHeight;
    viewportNode!.dispatchEvent(new Event("scroll"));
  });
  const firstIdAfterPositive = Number(
    host.querySelector<HTMLTableRowElement>("tbody tr[data-row-id]")!.dataset.rowId,
  );
  const unmeasuredBefore = firstIdAfterPositive - 1 - INITIAL_WINDOW_ROWS;
  expect(readSpacerHeight("top")).toBe(INITIAL_WINDOW_ROWS * 60 + unmeasuredBefore * rowHeight);
});

test("toggling enabled false to true calls measure and drops stale row height cache", async () => {
  const records = makeRows(500);
  const rowHeight = DEFAULT_ROW_HEIGHT_ESTIMATE;

  // Measure rows near index 200 at 60px while enabled.
  stubRowHeight = 60;
  await mount({ records, enabled: true, viewportHeight: 370 });
  await act(async () => {
    viewportNode!.scrollTop = 200 * rowHeight;
    viewportNode!.dispatchEvent(new Event("scroll"));
  });
  const deepCount = latest.visibleRecords.length;
  expect(deepCount).toBeGreaterThan(0);

  // Switch to paged mode (enabled=false), reset scroll and restore default row height.
  await act(async () => {
    viewportNode!.scrollTop = 0;
    viewportNode!.dispatchEvent(new Event("scroll"));
  });
  await mount({ records, enabled: false, viewportHeight: 370 });
  stubRowHeight = 0;

  // Re-enable All mode: virtualizer.measure() clears the stale 60px cache for rows near 200,
  // so the bottom spacer reflects DEFAULT_ROW_HEIGHT_ESTIMATE for every unrendered row.
  await mount({ records, enabled: true, viewportHeight: 370 });
  expect(readSpacerHeight("bottom")).toBe(
    (records.length - latest.visibleRecords.length) * rowHeight,
  );
});

test("paged mode (enabled=false) passes all records through unwindowed with no rowFactory", async () => {
  const records = makeRows(50);
  await mount({ records, enabled: false, viewportHeight: 370 });

  expect(latest.visibleRecords).toBe(records);
  expect(latest.rowFactory).toBeUndefined();
  expect(host.querySelectorAll("tbody tr[data-row-id]")).toHaveLength(50);
  expect(host.querySelector("[data-virtual-spacer]")).toBeNull();
});

test("resetKey cancels a pending virtualizer scrollToIndex rAF loop to an unmeasured index", async () => {
  const initialRecords = makeRows(250);
  const reorderedRecords = Array.from({ length: 250 }, (_, index) => ({
    id: 1000 + index,
    label: `Sorted ${index + 1}`,
  }));

  // Mount with viewportHeight=0 so scrollToIndex(60) takes the virtualizer.scrollToIndex branch
  // and schedules a rAF verification loop for index 60.
  stubRowHeight = DEFAULT_ROW_HEIGHT_ESTIMATE;
  await mount({
    records: initialRecords,
    enabled: true,
    viewportHeight: 0,
    resetKey: "date:desc",
  });

  await act(async () => {
    latest.scrollToIndex(60);
  });

  // Before the rAF verification fires, the viewport becomes measurable and the list identity resets.
  await mount({
    records: reorderedRecords,
    enabled: true,
    viewportHeight: 370,
    resetKey: "plyCount:desc",
  });

  // Flush the pending rAF callbacks (verify -> scheduleRetry -> tryScroll): index-60 verification
  // must be cancelled, leaving offset at 0.
  await act(async () => {
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  });

  expect(viewportNode!.scrollTop).toBe(0);
  expect(host.querySelector('[data-virtual-spacer="top"]')).toBeNull();
  const firstRow = host.querySelector<HTMLTableRowElement>("tbody tr");
  expect(firstRow?.dataset.rowId).toBe(String(reorderedRecords[0].id));
});

test("live-DOM-offset guard prevents taller row measurements from pulling a DOM scrollTop=0 viewport back down", async () => {
  const records = makeRows(250);
  stubRowHeight = DEFAULT_ROW_HEIGHT_ESTIMATE;
  await mount({
    records,
    enabled: true,
    viewportHeight: 370,
    resetKey: "date:desc",
    suppressScrollEvent: true,
  });

  // Scroll mid-list so virtualizer.scrollOffset is 1000.
  await act(async () => {
    viewportNode!.scrollTop = 1000;
    viewportNode!.dispatchEvent(new Event("scroll"));
  });
  expect(viewportNode!.scrollTop).toBe(1000);

  // Move DOM scrollTop to 0 without firing the async scroll event yet (stale scrollOffset=1000),
  // then mount fresh row nodes (new ids) that measure taller (60px) on the same resetKey so
  // measureElement / resizeItem runs for rows above the stale cached offset.
  stubRowHeight = 60;
  await act(async () => {
    viewportNode!.scrollTo({ top: 0 });
  });
  await mount({
    records: records.map((row, index) => ({ ...row, id: 1000 + index })),
    enabled: true,
    viewportHeight: 370,
    resetKey: "date:desc",
    suppressScrollEvent: true,
  });

  expect(viewportNode!.scrollTop).toBe(0);
});

test("resetKey change resets scroll offset to 0 with row 1 first even with taller measured rows and no external scrollTo", async () => {
  const initialRecords = makeRows(250);
  const reorderedRecords = Array.from({ length: 250 }, (_, index) => ({
    id: 1000 + index,
    label: `Sorted ${index + 1}`,
  }));

  stubRowHeight = DEFAULT_ROW_HEIGHT_ESTIMATE;
  await mount({
    records: initialRecords,
    enabled: true,
    viewportHeight: 370,
    resetKey: "date:desc",
    suppressScrollEvent: true,
  });

  await act(async () => {
    viewportNode!.scrollTop = 1000;
    viewportNode!.dispatchEvent(new Event("scroll"));
  });
  expect(viewportNode!.scrollTop).toBe(1000);

  // Change resetKey with taller reordered rows (no external DOM scrollTo): hook must reset to 0.
  stubRowHeight = 60;
  await mount({
    records: reorderedRecords,
    enabled: true,
    viewportHeight: 370,
    resetKey: "plyCount:desc",
    suppressScrollEvent: true,
  });

  expect(viewportNode!.scrollTop).toBe(0);
  expect(host.querySelector('[data-virtual-spacer="top"]')).toBeNull();
  const firstRow = host.querySelector<HTMLTableRowElement>("tbody tr");
  expect(firstRow?.dataset.rowId).toBe(String(reorderedRecords[0].id));
});

test("reset arriving while records are empty completes when the new records populate", async () => {
  const initialRecords = makeRows(250);
  const reorderedRecords = Array.from({ length: 250 }, (_, index) => ({
    id: 2000 + index,
    label: `Populated ${index + 1}`,
  }));

  // Trigger a pending virtualizer scrollToIndex(60) while unmeasured.
  stubRowHeight = DEFAULT_ROW_HEIGHT_ESTIMATE;
  await mount({
    records: initialRecords,
    enabled: true,
    viewportHeight: 0,
    resetKey: "date:desc",
    suppressScrollEvent: true,
  });
  await act(async () => {
    latest.scrollToIndex(60);
  });

  // Uncached sort: resetKey changes while records are temporarily empty and scroll events are
  // suppressed, so the hook must keep pendingResetRef set until records populate.
  await mount({
    records: [],
    enabled: true,
    viewportHeight: 370,
    resetKey: "plyCount:desc",
    suppressScrollEvent: true,
  });

  // New sorted chunk arrives: pendingResetRef runs scrollToIndex(0), superseding index 60.
  stubRowHeight = 60;
  await mount({
    records: reorderedRecords,
    enabled: true,
    viewportHeight: 370,
    resetKey: "plyCount:desc",
    suppressScrollEvent: true,
  });

  await act(async () => {
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  });

  expect(viewportNode!.scrollTop).toBe(0);
  expect(host.querySelector('[data-virtual-spacer="top"]')).toBeNull();
  const firstRow = host.querySelector<HTMLTableRowElement>("tbody tr");
  expect(firstRow?.dataset.rowId).toBe(String(reorderedRecords[0].id));
});

test("resetKey changing while disabled still resets to offset 0 once enabled", async () => {
  const initialRecords = makeRows(250);
  const nextRecords = Array.from({ length: 250 }, (_, index) => ({
    id: 4000 + index,
    label: `Re-enabled ${index + 1}`,
  }));

  await mount({
    records: initialRecords,
    enabled: true,
    viewportHeight: 370,
    resetKey: "a",
  });
  await act(async () => {
    viewportNode!.scrollTop = 1000;
    viewportNode!.dispatchEvent(new Event("scroll"));
  });
  expect(viewportNode!.scrollTop).toBe(1000);

  // Switch to paged mode (enabled=false) and change resetKey away and back while disabled.
  await mount({
    records: initialRecords.slice(0, 25),
    enabled: false,
    viewportHeight: 370,
    resetKey: "b",
  });
  await mount({
    records: initialRecords.slice(0, 25),
    enabled: false,
    viewportHeight: 370,
    resetKey: "a",
  });
  expect(viewportNode!.scrollTop).toBe(1000);

  // Re-enable All mode with resetKey "a": pending reset recorded while disabled still runs.
  await mount({
    records: nextRecords,
    enabled: true,
    viewportHeight: 370,
    resetKey: "a",
  });
  expect(viewportNode!.scrollTop).toBe(0);
  expect(host.querySelector('[data-virtual-spacer="top"]')).toBeNull();
  const firstRow = host.querySelector<HTMLTableRowElement>("tbody tr");
  expect(firstRow?.dataset.rowId).toBe(String(nextRecords[0].id));
});

test("falls back to direct viewport.scrollTop assignment when viewport.scrollTo is absent", async () => {
  const records = makeRows(250);
  const rowHeight = DEFAULT_ROW_HEIGHT_ESTIMATE;
  await mount({
    records,
    enabled: true,
    viewportHeight: 410,
    headerHeight: 40,
    resetKey: "a",
    omitScrollTo: true,
  });
  expect(viewportNode!.scrollTo).toBeUndefined();

  // Scroll down beyond viewport via fallback branch.
  await act(async () => {
    latest.scrollToIndex(100);
  });
  expect(viewportNode!.scrollTop).toBe(101 * rowHeight - 370);

  // Scroll up above viewport via fallback branch.
  await act(async () => {
    latest.scrollToIndex(10);
  });
  expect(viewportNode!.scrollTop).toBe(10 * rowHeight);

  // Reset via resetKey while scrollTo is absent sets scrollTop to 0 (both non-empty and empty).
  await mount({
    records,
    enabled: true,
    viewportHeight: 410,
    headerHeight: 40,
    resetKey: "b",
    omitScrollTo: true,
  });
  expect(viewportNode!.scrollTop).toBe(0);

  await act(async () => {
    viewportNode!.scrollTop = 500;
  });
  await mount({
    records: [],
    enabled: true,
    viewportHeight: 410,
    headerHeight: 40,
    resetKey: "c",
    omitScrollTo: true,
  });
  expect(viewportNode!.scrollTop).toBe(0);
});

test("an immediate scrollToIndex after a reset is not pulled back to 0", async () => {
  const initialRecords = makeRows(250);
  const reorderedRecords = Array.from({ length: 250 }, (_, index) => ({
    id: 3000 + index,
    label: `Next ${index + 1}`,
  }));

  stubRowHeight = DEFAULT_ROW_HEIGHT_ESTIMATE;
  await mount({
    records: initialRecords,
    enabled: true,
    viewportHeight: 370,
    resetKey: "date:desc",
  });

  await mount({
    records: reorderedRecords,
    enabled: true,
    viewportHeight: 370,
    resetKey: "plyCount:desc",
  });

  await act(async () => {
    latest.scrollToIndex(50);
  });
  const targetOffset = viewportNode!.scrollTop;
  expect(targetOffset).toBeGreaterThan(0);

  await act(async () => {
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  });
  expect(viewportNode!.scrollTop).toBe(targetOffset);
});
