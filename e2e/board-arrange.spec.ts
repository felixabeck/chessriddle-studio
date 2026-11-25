import type { Page } from "@playwright/test";
import {
    dragMosaicDivider,
    expect,
    goToSettings,
    preserveStorageForReload,
    test,
} from "./fixtures";

async function openAnalysisBoard(page: Page) {
    await page.goto("/");
    await page.getByRole("button", { name: /^Analysis Board$/ }).click();
}

const LEGACY_KEYS = [
    "panels-beside-notation",
    "board-beside-splits",
    "detached-explorer",
    "detached-explorer-placement",
    "detached-explorer-heights",
] as const;

test("board-arrange: carries over legacy beside + pinned database, handles width fallback, divider persistence, Return and Reset", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
}) => {
    await mockScenario({});
    await page.addInitScript(() => {
        localStorage.setItem("panels-beside-notation", "true");
        localStorage.setItem("board-beside-splits", JSON.stringify({ board: 42, notation: 52 }));
        localStorage.setItem("detached-explorer", "true");
        localStorage.setItem("detached-explorer-placement", JSON.stringify("tabs"));
        localStorage.setItem("detached-explorer-heights", JSON.stringify({ tabs: 220 }));
    });
    await openAnalysisBoard(page);

    const layout = page.locator("[data-board-layout]");
    const dbArea = page.locator('[data-panel-area="database"]');
    await expect(layout).toHaveAttribute("data-board-layout", "mosaic");
    await expect(dbArea).toBeVisible();
    await expect(page.getByRole("tab", { name: "Database", exact: true })).toHaveCount(0);

    // Carry-over wrote `analysis-board-layout` and removed all five legacy keys.
    const afterCarryOver = await page.evaluate((keys) => {
        const stored = JSON.parse(localStorage.getItem("analysis-board-layout")!);
        const remaining = keys.filter((key) => localStorage.getItem(key) !== null);
        return { stored, remaining };
    }, LEGACY_KEYS);
    expect(afterCarryOver.remaining).toEqual([]);
    expect(afterCarryOver.stored).toEqual({
        direction: "row",
        first: "left",
        splitPercentage: 42,
        second: {
            direction: "column",
            first: "database",
            splitPercentage: 30,
            second: {
                direction: "row",
                first: "bottomRight",
                second: "topRight",
                splitPercentage: 52,
            },
        },
    });
    await assertNoHorizontalOverflow("wide-carried-over");
    await expect(layout).toHaveScreenshot("board-arrange-beside-database.png");

    // Dragging the outer row divider persists in `analysis-board-layout` across reload.
    const mosaic = layout.locator(".mosaic-root");
    await dragMosaicDivider(page, {
        root: mosaic,
        split: mosaic.locator("> .mosaic-split.-row").first(),
        percentage: 48,
        direction: "row",
        crossAxisRatio: 0.25,
    });
    await page.mouse.move(0, 0);
    await expect
        .poll(() =>
            page.evaluate(() =>
                Math.abs(
                    JSON.parse(localStorage.getItem("analysis-board-layout")!).splitPercentage - 48,
                ),
            ),
        )
        .toBeLessThan(1);
    const draggedSplit = await page.evaluate(
        () => JSON.parse(localStorage.getItem("analysis-board-layout")!).splitPercentage,
    );
    await preserveStorageForReload(page);
    await expect(dbArea).toBeVisible();
    expect(
        await page.evaluate(
            () => JSON.parse(localStorage.getItem("analysis-board-layout")!).splitPercentage,
        ),
    ).toBeCloseTo(draggedSplit, 1);

    // Case 3: too narrow for 3 panes (800 x 720) falls back to shared layout with all panels in tabs.
    await page.setViewportSize({ width: 800, height: 720 });
    await expect(layout).toHaveAttribute("data-board-layout", "mosaic");
    await expect(dbArea).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Database", exact: true })).toBeVisible();
    await assertNoHorizontalOverflow("fallback-800x720");

    // Case 1: narrower than two pane floors switches to stacked.
    await page.setViewportSize({ width: 600, height: 720 });
    await expect(layout).toHaveAttribute("data-board-layout", "stacked");
    await expect(dbArea).toHaveCount(0);

    // Widening back restores the stored arrangement with Database as its own area.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(layout).toHaveAttribute("data-board-layout", "mosaic");
    await expect(dbArea).toBeVisible();
    await assertNoHorizontalOverflow("wide-1440x1000");

    // Return button moves Database back to the tabs and selects it.
    await dbArea.getByRole("button", { name: "Return to the tabs", exact: true }).click();
    await expect(dbArea).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Database", exact: true })).toHaveAttribute(
        "aria-selected",
        "true",
    );

    // Reset layout in Settings restores the default arrangement.
    await goToSettings(page);
    await page.getByRole("tab", { name: "Analysis & notation", exact: true }).click();
    await page.getByRole("button", { name: "Reset layout", exact: true }).click();
    const afterReset = await page.evaluate(() =>
        JSON.parse(localStorage.getItem("analysis-board-layout")!),
    );
    expect(afterReset).toEqual({
        direction: "row",
        first: "left",
        second: { direction: "column", first: "topRight", second: "bottomRight" },
    });
});

test("board-arrange: database area below the board renders cleanly and 200% font scale follows scaled pane floor", async ({
    page,
    mockScenario,
}) => {
    await mockScenario({});
    const belowBoard = {
        direction: "row",
        first: {
            direction: "column",
            first: "left",
            second: "database",
            splitPercentage: 70,
        },
        second: {
            direction: "column",
            first: "topRight",
            second: "bottomRight",
        },
    };
    await page.addInitScript((arrangement) => {
        localStorage.setItem("analysis-board-layout", JSON.stringify(arrangement));
    }, belowBoard);
    await openAnalysisBoard(page);

    const layout = page.locator("[data-board-layout]");
    const dbArea = page.locator('[data-panel-area="database"]');
    await expect(dbArea).toBeVisible();
    await expect(layout).toHaveScreenshot("board-arrange-database-below-board.png");

    // At 200% font scale, a 3-pane arrangement needs >= 1932px, so 1440px falls back to shared layout;
    // the 2-pane arrangement here needs >= 1286px and still fits at 1440px without header overflow.
    await page.evaluate(() => {
        localStorage.setItem("font-size", "200");
        document.documentElement.style.fontSize = "32px";
    });
    await preserveStorageForReload(page);
    await expect(dbArea).toBeVisible();
    const headerFits = await dbArea.evaluate((area) => {
        const header = area.firstElementChild as HTMLElement;
        return header.scrollWidth <= header.clientWidth + 1;
    });
    expect(headerFits).toBe(true);

    // At 1200px with 200% font scale (< 1286px), the board stacks and the panel area returns to tabs.
    await page.setViewportSize({ width: 1200, height: 900 });
    await expect(layout).toHaveAttribute("data-board-layout", "stacked");
    await expect(dbArea).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Database", exact: true })).toBeVisible();
});
