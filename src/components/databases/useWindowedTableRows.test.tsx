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
  }: { clientHeight: number; scrollHeight: number; scrollTop?: number; headerHeight?: number },
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
  node.scrollTo = ((optionsOrX?: ScrollToOptions | number, y?: number) => {
    const nextTop = typeof optionsOrX === "number" ? (y ?? 0) : (optionsOrX?.top ?? 0);
    currentScrollTop = nextTop;
    node.dispatchEvent(new Event("scroll"));
  }) as typeof node.scrollTo;

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
}: {
  records: Row[];
  enabled: boolean;
  viewportHeight: number;
  headerHeight?: number;
}) {
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const node = scrollViewportRef.current;
    viewportNode = node;
    if (node) {
      setViewportMetrics(node, {
        clientHeight: viewportHeight,
        scrollHeight: headerHeight + records.length * DEFAULT_ROW_HEIGHT_ESTIMATE,
        scrollTop: node.scrollTop || 0,
        headerHeight,
      });
    }
  }, [viewportHeight, headerHeight, records.length]);

  const windowing = useWindowedTableRows({
    records,
    enabled,
    scrollViewportRef,
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
  await act(async () => {
    latest.scrollToIndex(100);
  });
  expect(viewportNode!.scrollTop).toBe(101 * rowHeight - 370);
  expect(latest.visibleRecords.some((row) => row.id === 101)).toBe(true);

  // Index 10 (start=370) is above current viewTop -> scrolls up to 370.
  await act(async () => {
    latest.scrollToIndex(10);
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
