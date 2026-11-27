import type { Page } from "@playwright/test";
import {
    dragMosaicDivider,
    expect,
    goToSettings,
    preserveStorageForReload,
    seedAnalysisEngines,
    seedBoardLayouts,
    test,
} from "./fixtures";
import { importFromPhoto, scoresheetPhotoCommands } from "./scoresheetPhotoImport";
import { defaultLayoutForKind } from "../src/state/layoutPresets";

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

test.describe("legacy layout carry-over", () => {
    // Carry-over runs only when no layout is stored yet, so no default layout seed here.
    test.use({ shippedBoardLayouts: true });

    test("board-arrange: carries over legacy beside + pinned database, handles width fallback, divider persistence, Return and Reset", async ({
        page,
        mockScenario,
        assertNoHorizontalOverflow,
    }) => {
        await mockScenario({});
        await page.addInitScript(() => {
            localStorage.setItem("panels-beside-notation", "true");
            localStorage.setItem(
                "board-beside-splits",
                JSON.stringify({ board: 42, notation: 52 }),
            );
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

        // Carry-over wrote `analysis-board-layouts` (seeding all three kinds) and removed all five legacy keys.
        const expectedCarried = {
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
        };
        const afterCarryOver = await page.evaluate((keys) => {
            const stored = JSON.parse(localStorage.getItem("analysis-board-layouts")!);
            const remaining = keys.filter((key) => localStorage.getItem(key) !== null);
            return { stored, remaining };
        }, LEGACY_KEYS);
        expect(afterCarryOver.remaining).toEqual([]);
        expect(afterCarryOver.stored).toEqual({
            version: 1,
            kinds: {
                repertoire: { arrangement: expectedCarried, tabsHidden: false },
                game: { arrangement: expectedCarried, tabsHidden: false },
                preparation: { arrangement: expectedCarried, tabsHidden: false },
            },
            saved: [],
        });
        await assertNoHorizontalOverflow("wide-carried-over");
        await expect(layout).toHaveScreenshot("board-arrange-beside-database.png");

        // Dragging the outer row divider persists in `analysis-board-layouts` (game kind) across reload.
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
                        JSON.parse(localStorage.getItem("analysis-board-layouts")!).kinds.game
                            .arrangement.splitPercentage - 48,
                    ),
                ),
            )
            .toBeLessThan(1);
        const draggedSplit = await page.evaluate(
            () =>
                JSON.parse(localStorage.getItem("analysis-board-layouts")!).kinds.game.arrangement
                    .splitPercentage,
        );
        await preserveStorageForReload(page);
        await expect(dbArea).toBeVisible();
        expect(
            await page.evaluate(
                () =>
                    JSON.parse(localStorage.getItem("analysis-board-layouts")!).kinds.game
                        .arrangement.splitPercentage,
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

        // Reset layout in Settings restores all three kinds to their presets.
        await goToSettings(page);
        await page.getByRole("tab", { name: "Analysis & notation", exact: true }).click();
        await page.getByRole("button", { name: "Reset layout", exact: true }).click();
        const afterReset = await page.evaluate(() =>
            JSON.parse(localStorage.getItem("analysis-board-layouts")!),
        );
        expect(afterReset.version).toBe(1);
        expect(afterReset.saved).toEqual([]);
        expect(afterReset.kinds.game).toEqual(defaultLayoutForKind("game"));
        expect(afterReset.kinds.repertoire).toEqual(defaultLayoutForKind("repertoire"));
        expect(afterReset.kinds.preparation).toEqual(defaultLayoutForKind("preparation"));
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
    } as const;
    await seedBoardLayouts(page, belowBoard);
    await openAnalysisBoard(page);

    const layout = page.locator("[data-board-layout]");
    const dbArea = page.locator('[data-panel-area="database"]');
    const boardTile = page.locator("#left");
    const cgBoard = boardTile.locator("cg-board");
    await expect(dbArea).toBeVisible();
    await expect(cgBoard).toBeVisible();

    const assertBoardInsideTile = async () => {
        const tileBox = (await boardTile.boundingBox())!;
        const boardBox = (await cgBoard.boundingBox())!;
        expect(boardBox.y).toBeGreaterThanOrEqual(tileBox.y - 1);
        expect(boardBox.y + boardBox.height).toBeLessThanOrEqual(tileBox.y + tileBox.height + 1);
        expect(boardBox.x).toBeGreaterThanOrEqual(tileBox.x - 1);
        expect(boardBox.x + boardBox.width).toBeLessThanOrEqual(tileBox.x + tileBox.width + 1);
    };

    // At 1440x900 and 800x720 (both 2 panes -> mosaic) with Database below the board, the board
    // must shrink to stay fully inside its tile.
    await assertBoardInsideTile();
    await page.setViewportSize({ width: 800, height: 720 });
    await expect(dbArea).toBeVisible();
    await assertBoardInsideTile();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(dbArea).toBeVisible();
    await assertBoardInsideTile();

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

test("board-arrange: drag Database below board and reload, move notation beside tabs, return by button", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
}) => {
    await mockScenario({});
    await openAnalysisBoard(page);

    const layout = page.locator("[data-board-layout]");
    const dbTab = page.getByRole("tab", { name: "Database", exact: true });
    const boardArea = page.locator("#left");
    const tabsArea = page.locator("#topRight");
    const dbArea = page.locator('[data-panel-area="database"]');

    await expect(dbTab).toBeVisible();
    const tabBox = (await dbTab.boundingBox())!;
    const boardBox = (await boardArea.boundingBox())!;

    // Press Database tab and drag to the bottom edge of the board; verify drag preview snapshot.
    await page.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(boardBox.x + boardBox.width / 2, boardBox.y + boardBox.height - 24, {
        steps: 8,
    });
    const preview = page.getByTestId("board-arrange-preview");
    await expect(preview).toBeVisible();
    await expect(preview).toHaveAttribute("data-arrange-target", "left");
    await expect(preview).toHaveAttribute("data-arrange-side", "bottom");
    await expect(layout).toHaveScreenshot("board-arrange-drag-preview.png");

    // Release to place Database below the board, then reload and verify persistence.
    await page.mouse.up();
    await expect(preview).toHaveCount(0);
    await expect(dbArea).toBeVisible();
    await expect(dbTab).toHaveCount(0);

    await preserveStorageForReload(page);
    await expect(dbArea).toBeVisible();
    expect(
        await page.evaluate(
            () =>
                JSON.parse(localStorage.getItem("analysis-board-layouts")!).kinds.game.arrangement,
        ),
    ).toEqual({
        direction: "row",
        first: {
            direction: "column",
            first: "left",
            second: "database",
            splitPercentage: 50,
        },
        second: {
            direction: "column",
            first: "topRight",
            second: "bottomRight",
        },
    });

    // Drag notation grip to the left edge of the tab strip (notation beside tabs).
    const notationGrip = page.locator('[data-arrange-grip="bottomRight"]');
    const gripBox = (await notationGrip.boundingBox())!;
    const tabsBox = (await tabsArea.boundingBox())!;
    await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(tabsBox.x + 24, tabsBox.y + tabsBox.height / 2, { steps: 8 });
    await expect(preview).toBeVisible();
    await expect(preview).toHaveAttribute("data-arrange-target", "topRight");
    await expect(preview).toHaveAttribute("data-arrange-side", "left");
    await page.mouse.up();
    await expect(preview).toHaveCount(0);

    const afterNotationMove = await page.evaluate(
        () => JSON.parse(localStorage.getItem("analysis-board-layouts")!).kinds.game.arrangement,
    );
    expect(afterNotationMove.second).toEqual({
        direction: "row",
        first: "bottomRight",
        second: "topRight",
        splitPercentage: 50,
    });
    await assertNoHorizontalOverflow("dragged-database-and-notation");

    // Return Database by button.
    await dbArea.getByRole("button", { name: "Return to the tabs", exact: true }).click();
    await expect(dbArea).toHaveCount(0);
    await expect(dbTab).toHaveAttribute("aria-selected", "true");
});

test("board-arrange: keyboard placing, aria-modal hotkey suppression, fit rule, and 200% font scale targets", async ({
    page,
    mockScenario,
}) => {
    await mockScenario({});
    await openAnalysisBoard(page);

    const layout = page.locator("[data-board-layout]");
    const stripGrip = page.locator('[data-arrange-grip="topRight"]');
    const placingDialog = page.getByTestId("board-arrange-placing");
    const dbArea = page.locator('[data-panel-area="database"]');

    // Open tab strip grip menu by keyboard and choose "Show Database as its own area".
    await stripGrip.focus();
    await page.keyboard.press("Enter");
    const showDatabase = page.getByRole("menuitem", { name: "Show Database as its own area" });
    await expect(showDatabase).toBeVisible();
    await showDatabase.click();

    await expect(placingDialog).toBeVisible();
    await expect(placingDialog).toHaveAttribute("aria-modal", "true");
    await expect(layout).toHaveScreenshot("board-arrange-placing-targets.png");

    // Place Database below the board by keyboard activation, verify focus moves to Database's grip.
    const belowBoardBtn = placingDialog.getByRole("button", {
        name: "Below the board",
        exact: true,
    });
    await belowBoardBtn.focus();
    await page.keyboard.press("Enter");
    await expect(placingDialog).toHaveCount(0);
    await expect(dbArea).toBeVisible();
    await expect(page.locator('[data-arrange-grip="database"]')).toBeFocused();

    // Move notation beside tabs by keyboard via notation grip.
    const notationGrip = page.locator('[data-arrange-grip="bottomRight"]');
    await notationGrip.focus();
    await page.keyboard.press("Enter");
    await expect(placingDialog).toBeVisible();
    await placingDialog.getByRole("button", { name: "Left of the tabs", exact: true }).click();
    await expect(placingDialog).toHaveCount(0);
    await expect(notationGrip).toBeFocused();

    // Fit rule: at 1100px width, 3 panes (board | notation | tabs) fit, 4 panes do not.
    await page.setViewportSize({ width: 1100, height: 900 });
    await expect(layout).toHaveAttribute("data-board-layout", "mosaic");
    await stripGrip.click();
    await page.getByRole("menuitem", { name: "Show Analysis as its own area" }).click();
    await expect(placingDialog).toBeVisible();
    const targetNames = await placingDialog.getByRole("button").allInnerTexts();
    // Sideways placement beside board, notation or tabs would require 4 panes and must not be offered.
    expect(targetNames).not.toContain("Left of the board");
    expect(targetNames).not.toContain("Right of the board");
    expect(targetNames).not.toContain("Left of the notation");
    expect(targetNames).not.toContain("Right of the notation");
    expect(targetNames).not.toContain("Left of the tabs");
    expect(targetNames).not.toContain("Right of the tabs");
    await page.keyboard.press("Escape");
    await expect(placingDialog).toHaveCount(0);

    // Return Database by keyboard ("Back into the tabs"), verify focus and selection on Database tab.
    await page.setViewportSize({ width: 1440, height: 900 });
    const dbGrip = page.locator('[data-arrange-grip="database"]');
    await dbGrip.focus();
    await page.keyboard.press("Enter");
    await expect(placingDialog).toBeVisible();
    await placingDialog.getByRole("button", { name: "Back into the tabs", exact: true }).click();
    await expect(placingDialog).toHaveCount(0);
    await expect(dbArea).toHaveCount(0);
    const dbTab = page.getByRole("tab", { name: "Database", exact: true });
    await expect(dbTab).toBeFocused();
    await expect(dbTab).toHaveAttribute("aria-selected", "true");

    // Board hotkeys (e.g. ArrowLeft move navigation) do nothing while placing is open.
    const e2 = page.locator("cg-board").first();
    const boardBox = (await e2.boundingBox())!;
    // White e2 -> e4 (file 4 from 0..7, rank 6 -> 4 from top)
    await page.mouse.click(
        boardBox.x + boardBox.width * (4.5 / 8),
        boardBox.y + boardBox.height * (6.5 / 8),
    );
    await page.mouse.click(
        boardBox.x + boardBox.width * (4.5 / 8),
        boardBox.y + boardBox.height * (4.5 / 8),
    );
    await expect(page.locator('[data-notation-current="true"]')).toContainText("e4");
    await notationGrip.focus();
    await page.keyboard.press("Enter");
    await expect(placingDialog).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator('[data-notation-current="true"]')).toContainText("e4");
    await page.keyboard.press("Escape");
    await expect(placingDialog).toHaveCount(0);

    // 200% font scale: grips, panel area header and placing targets do not overflow or clip.
    await page.evaluate(() => {
        const stored = JSON.parse(localStorage.getItem("analysis-board-layouts")!);
        stored.kinds.game = {
            arrangement: {
                direction: "row",
                first: {
                    direction: "column",
                    first: "left",
                    second: "database",
                    splitPercentage: 65,
                },
                second: { direction: "column", first: "topRight", second: "bottomRight" },
            },
            tabsHidden: false,
        };
        localStorage.setItem("analysis-board-layouts", JSON.stringify(stored));
        localStorage.setItem("font-size", "200");
        document.documentElement.style.fontSize = "32px";
    });
    await preserveStorageForReload(page);
    await expect(dbArea).toBeVisible();
    await expect(page.locator('[data-arrange-grip="database"]')).toBeVisible();
    await expect(page.locator('[data-arrange-grip="bottomRight"]')).toBeVisible();
    await expect(page.locator('[data-arrange-grip="topRight"]')).toBeVisible();

    const headerFits = await dbArea.evaluate((area) => {
        const header = area.firstElementChild as HTMLElement;
        return header.scrollWidth <= header.clientWidth + 1;
    });
    expect(headerFits).toBe(true);

    await page.locator('[data-arrange-grip="database"]').click();
    await expect(placingDialog).toBeVisible();
    const dialogFits = await placingDialog.evaluate((el) => {
        const buttons = [...el.querySelectorAll("button")];
        return (
            el.scrollWidth <= el.clientWidth + 1 &&
            buttons.every((button) => button.scrollWidth <= button.clientWidth + 1)
        );
    });
    expect(dialogFits).toBe(true);
});

test("board-arrange: hiding the tabs keeps their place and size, survives reload, and Show tabs restores them", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
}) => {
    await mockScenario({});
    const stored = {
        direction: "row",
        first: "left",
        splitPercentage: 50,
        second: {
            direction: "column",
            first: "database",
            splitPercentage: 30,
            second: {
                direction: "column",
                first: "topRight",
                second: "bottomRight",
                splitPercentage: 40,
            },
        },
    } as const;
    await seedBoardLayouts(page, stored);
    await openAnalysisBoard(page);

    const tabList = page.locator("[data-board-tab-list]");
    await expect(tabList).toBeVisible();
    const hide = page.getByRole("button", { name: "Hide the tabs" });
    await hide.hover();
    await expect(page.getByRole("tooltip", { name: "Hide the tabs" })).toBeVisible();
    await hide.click();
    await expect(tabList).toBeHidden();
    await expect(page.locator('[data-panel-area="database"]')).toBeVisible();
    // The hovered button's tooltip does not stay behind (the stuck tooltip showed only in WebKit;
    // BoardAnalysis.test.tsx guards the mechanism: the × is unmounted while hidden).
    await expect(page.getByRole("tooltip", { name: "Hide the tabs" })).toHaveCount(0);

    // Returning the Database area while hidden keeps the tabs hidden.
    await page
        .locator('[data-panel-area="database"]')
        .getByRole("button", { name: "Return to the tabs" })
        .click();
    await expect(page.locator('[data-panel-area="database"]')).toHaveCount(0);
    await expect(tabList).toBeHidden();

    await preserveStorageForReload(page);
    await expect(page.locator("[data-board-layout]")).toHaveAttribute(
        "data-board-layout",
        "mosaic",
    );
    await expect(tabList).toBeHidden();
    expect(
        await page.evaluate(
            () => JSON.parse(localStorage.getItem("analysis-board-layouts")!).kinds.game.tabsHidden,
        ),
    ).toBe(true);

    // While hidden, the notation grip still starts placing the notation directly.
    await page.locator('[data-arrange-grip="bottomRight"]').click();
    await expect(page.getByTestId("board-arrange-placing")).toBeVisible();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("board-arrange-placing")).toHaveCount(0);

    // The notation header shows a Show the tabs button while they are hidden.
    const showTabs = page
        .locator("#bottomRight")
        .getByRole("button", { name: "Show the tabs", exact: true });
    await expect(showTabs).toBeVisible();
    await assertNoHorizontalOverflow("tabs-hidden-notation-header");
    const buttonBox = (await showTabs.boundingBox())!;
    const tileBox = (await page.locator("#bottomRight").boundingBox())!;
    expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(tileBox.x + tileBox.width);
    expect(buttonBox.y).toBeGreaterThanOrEqual(tileBox.y);
    await showTabs.click();
    await expect(tabList).toBeVisible();
    await expect(showTabs).toHaveCount(0);
    expect(
        await page.evaluate(
            () => JSON.parse(localStorage.getItem("analysis-board-layouts")!).kinds.game,
        ),
    ).toEqual({
        arrangement: {
            direction: "row",
            first: "left",
            splitPercentage: 50,
            second: {
                direction: "column",
                first: "topRight",
                second: "bottomRight",
                splitPercentage: 40,
            },
        },
        tabsHidden: false,
    });
});

test("board-arrange: Report tab lives in the strip and pulls out as its own area, and engine leaves follow arrangement fallback and return", async ({
    page,
    mockScenario,
}) => {
    await mockScenario({});
    await seedAnalysisEngines(page, [
        { id: "arrange-engine-1", name: "Arrange Stockfish", handleId: "e2e-engine-handle" },
        { id: "arrange-engine-2", name: "Arrange Leela", handleId: "e2e-engine-handle" },
    ]);
    await openAnalysisBoard(page);

    const layout = page.locator("[data-board-layout]");
    const tabsArea = page.locator("#topRight");
    const reportTab = tabsArea.getByRole("tab", { name: "Report", exact: true });
    const analysisTab = tabsArea.getByRole("tab", { name: "Analysis", exact: true });
    await expect(reportTab).toBeVisible();
    await expect(analysisTab).toBeVisible();
    // Analysis no longer hosts an inner Engines/Report tablist.
    await analysisTab.click();
    await expect(tabsArea.getByRole("tablist")).toHaveCount(1);
    await expect(tabsArea.getByRole("tab", { name: "Engines", exact: true })).toHaveCount(0);

    // Pull Report out as its own area via the strip grip menu.
    await page.locator('[data-arrange-grip="topRight"]').click();
    await page.getByRole("menuitem", { name: "Show Report as its own area", exact: true }).click();
    const placingDialog = page.getByTestId("board-arrange-placing");
    await expect(placingDialog).toBeVisible();
    await placingDialog.getByRole("button", { name: "Below the board", exact: true }).click();
    await expect(placingDialog).toHaveCount(0);

    const reportArea = page.locator('[data-panel-area="report"]');
    await expect(reportArea).toBeVisible();
    await expect(reportArea.getByTestId("report-needs-moves")).toBeVisible();
    await expect(reportTab).toHaveCount(0);

    await preserveStorageForReload(page);
    await expect(reportArea).toBeVisible();
    await expect(reportTab).toHaveCount(0);

    await reportArea.getByRole("button", { name: "Return to the tabs", exact: true }).click();
    await expect(reportArea).toHaveCount(0);
    await expect(reportTab).toHaveAttribute("aria-selected", "true");

    // Pull Analysis out as its own area, then pull an engine leaf out beside the board.
    await page.locator('[data-arrange-grip="topRight"]').click();
    await page
        .getByRole("menuitem", { name: "Show Analysis as its own area", exact: true })
        .click();
    await placingDialog.getByRole("button", { name: "Below the notation", exact: true }).click();
    const analysisArea = page.locator('[data-panel-area="analysis"]');
    await expect(analysisArea).toBeVisible();

    await analysisArea.locator('[data-arrange-grip="engine:arrange-engine-1"]').click();
    await page.getByRole("menuitem", { name: "Show as its own area", exact: true }).click();
    await placingDialog.getByRole("button", { name: "Below the board", exact: true }).click();

    const engineWindow = page.locator('[data-engine-window="arrange-engine-1"]');
    await expect(engineWindow).toBeVisible();
    await expect(analysisArea.locator('[data-engine-card-id="arrange-engine-1"]')).toHaveCount(0);
    await expect(analysisArea.locator('[data-engine-card-id="arrange-engine-2"]')).toBeVisible();

    // Narrow stacked width hides detached areas and lists the engine back in the Engines panel.
    await page.setViewportSize({ width: 600, height: 800 });
    await expect(layout).toHaveAttribute("data-board-layout", "stacked");
    await expect(engineWindow).toHaveCount(0);
    await expect(analysisArea).toHaveCount(0);
    await tabsArea.getByRole("tab", { name: "Analysis", exact: true }).click();
    await expect(tabsArea.locator('[data-engine-card-id="arrange-engine-1"]')).toBeVisible();

    // Widening back restores the stored arrangement with both Analysis and the engine window.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(layout).toHaveAttribute("data-board-layout", "mosaic");
    await expect(engineWindow).toBeVisible();
    await expect(analysisArea).toBeVisible();

    // When Analysis is its own area, dragging an engine window onto the Analysis header returns it.
    const gripBox = (await engineWindow
        .locator('[data-arrange-grip="engine:arrange-engine-1"]')
        .boundingBox())!;
    const analysisHeaderBox = (await page.locator('[data-panel-header="analysis"]').boundingBox())!;
    await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(
        analysisHeaderBox.x + analysisHeaderBox.width / 2,
        analysisHeaderBox.y + analysisHeaderBox.height / 2,
        { steps: 8 },
    );
    const preview = page.getByTestId("board-arrange-preview");
    await expect(preview).toHaveAttribute("data-arrange-kind", "return");
    await expect(preview).toHaveAttribute("data-arrange-target", "engines");
    await page.mouse.up();

    await expect(engineWindow).toHaveCount(0);
    await expect(analysisArea.locator('[data-engine-card-id="arrange-engine-1"]')).toBeVisible();
});

test("board-arrange: Photo panel pulls out, hides on non-review tabs while keeping its place, and returns on ×", async ({
    page,
    mockScenario,
}) => {
    await mockScenario({ commands: scoresheetPhotoCommands() });
    await page.goto("/");
    await importFromPhoto(page);

    const photoTab = page.locator('[data-panel-tab="photo"]');
    await expect(photoTab).toBeVisible();
    await expect(photoTab).toHaveAttribute("data-draggable-tab", "true");

    // Grip menu lists "Show Photo as its own area".
    await page.locator('[data-arrange-grip="topRight"]').click();
    const showPhoto = page.getByRole("menuitem", {
        name: "Show Photo as its own area",
        exact: true,
    });
    await expect(showPhoto).toBeVisible();
    await page.keyboard.press("Escape");

    // Drag the Photo strip tab below the board to pull it out.
    const tabBox = (await photoTab.boundingBox())!;
    const boardBox = (await page.locator("#left").boundingBox())!;
    await page.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(boardBox.x + boardBox.width / 2, boardBox.y + boardBox.height - 24, {
        steps: 8,
    });
    const preview = page.getByTestId("board-arrange-preview");
    await expect(preview).toBeVisible();
    await expect(preview).toHaveAttribute("data-arrange-target", "left");
    await expect(preview).toHaveAttribute("data-arrange-side", "bottom");
    await page.mouse.up();
    await expect(preview).toHaveCount(0);

    const photoArea = page.locator('[data-panel-area="photo"]');
    await expect(photoArea).toBeVisible();
    await expect(photoArea.locator('[data-panel-header="photo"]')).toContainText("Photo");
    await expect(photoTab).toHaveCount(0);
    const storedAfterPullOut = await page.evaluate(
        () => JSON.parse(localStorage.getItem("analysis-board-layouts")!).kinds.game.arrangement,
    );
    expect(JSON.stringify(storedAfterPullOut)).toContain('"photo"');

    // Open a non-review analysis tab: Photo tile hides while the stored arrangement keeps `"photo"`.
    await page.getByRole("button", { name: "New Tab", exact: true }).click();
    await page.getByRole("button", { name: /^Analysis Board$/ }).click();
    await expect(photoArea).toHaveCount(0);
    expect(
        await page.evaluate(
            () =>
                JSON.parse(localStorage.getItem("analysis-board-layouts")!).kinds.game.arrangement,
        ),
    ).toEqual(storedAfterPullOut);

    // Switching back to the review tab shows Photo in the exact same place (below the board `#left`).
    await page.getByRole("tab", { name: /Alice/ }).click();
    await expect(photoArea).toBeVisible();
    const restoredBoardBox = (await page.locator("#left").boundingBox())!;
    const restoredPhotoBox = (await photoArea.boundingBox())!;
    expect(restoredPhotoBox.y).toBeGreaterThanOrEqual(
        restoredBoardBox.y + restoredBoardBox.height - 1,
    );
    expect(Math.abs(restoredPhotoBox.x - restoredBoardBox.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(restoredPhotoBox.width - restoredBoardBox.width)).toBeLessThanOrEqual(2);

    // Clicking × returns Photo to the tab strip and selects it.
    await photoArea.getByRole("button", { name: "Return to the tabs", exact: true }).click();
    await expect(photoArea).toHaveCount(0);
    await expect(photoTab).toBeVisible();
    await expect(photoTab).toHaveAttribute("aria-selected", "true");
});
