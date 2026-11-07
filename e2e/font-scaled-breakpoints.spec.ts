import type { Locator, Page } from "@playwright/test";
import {
    assertNothingClipped,
    assertPageNotClipped,
    databaseCommands,
    expect,
    filesWorkspaceCommands,
    filesWorkspaceFixture,
    pgnFileCommands,
    test,
    type MockScenario,
    gameOpeningFixture,
    gameOpeningCommands,
    selectFilesTreeRow,
    whitePawnSquares,
    waitForFontsSettled,
    waitForScrollAreaScrollbarsHidden,
    wheelBoardStackTo,
    wheelColumnTo,
} from "./fixtures";

const databaseTitle = "Breakpoint database";

async function assertNotationColumn(page: Page, hasMoves: boolean) {
    await wheelBoardStackTo(page, page.locator("#bottomRight"));
    const end = page.getByRole("button", { name: "Go to end", exact: true });
    const column = end.locator("../..");
    const card = page.locator("#bottomRight .mantine-Paper-root").filter({
        has: page.getByRole("button", { name: "Table view", exact: true }),
    });
    const viewport = card.locator(".mantine-ScrollArea-viewport").last();
    const san = viewport.getByRole("button", { name: "e4", exact: true });
    if (hasMoves) {
        await expect(san, "notation has mounted main-line move rows").toBeVisible();
        await expect(viewport.locator("[data-index]")).not.toHaveCount(0);
    }
    await expect
        .poll(() =>
            viewport.evaluate((element) => {
                const box = element.getBoundingClientRect();
                const paper = element.closest(".mantine-Paper-root")!.getBoundingClientRect();
                const floor = 9 * parseFloat(getComputedStyle(document.documentElement).fontSize);
                return {
                    floor,
                    hasFloor: element.clientHeight >= floor,
                    insideCard:
                        box.top >= paper.top &&
                        box.bottom <= paper.bottom &&
                        box.left >= paper.left &&
                        box.right <= paper.right,
                };
            }),
        )
        .toEqual({ floor: 288, hasFloor: true, insideCard: true });
    await expect
        .poll(() => column.evaluate((element) => element.scrollHeight > element.clientHeight))
        .toBe(true);
    if (hasMoves) {
        await expect
            .poll(() =>
                san.evaluate((element) => {
                    const rowHeight = element.parentElement!.getBoundingClientRect().height;
                    const floor =
                        9 * parseFloat(getComputedStyle(document.documentElement).fontSize);
                    return floor >= 3 * rowHeight;
                }),
            )
            .toBe(true);
        await wheelColumnTo(page, column, san);
    }
    await wheelColumnTo(page, column, end);
    await expect.poll(() => column.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
}

test("wheelColumnTo retries after a first wheel miss", async ({ page }) => {
    await page.setContent(`
        <div
            id="column"
            style="height: 200px; overflow-y: auto; border-left: 1px solid black; width: 240px"
        >
            <div style="height: 800px">above</div>
            <button type="button">target</button>
            <div style="height: 800px">below</div>
        </div>
    `);
    const column = page.locator("#column");
    const target = page.getByRole("button", { name: "target", exact: true });
    await column.evaluate((element) => {
        element.addEventListener("wheel", (event) => event.preventDefault(), {
            capture: true,
            once: true,
            passive: false,
        });
    });

    await wheelColumnTo(page, column, target);

    await expect.poll(() => column.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect
        .poll(() =>
            target.evaluate((element) => {
                const box = element.getBoundingClientRect();
                const hit = document.elementFromPoint(
                    box.left + box.width / 2,
                    box.top + box.height / 2,
                );
                return hit !== null && element.contains(hit);
            }),
        )
        .toBe(true);
});

test("wheelColumnTo re-reveals a column scrolled out of the stacked viewport", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 720 });
    await page.setContent(`
        <div data-board-layout="stacked" style="width: 400px; height: 240px">
            <div style="height: 100%; overflow-y: auto; padding: 0 4px">
                <div id="board" style="height: 2000px">board</div>
                <div
                    id="column"
                    style="height: 200px; overflow-y: auto; border-left: 1px solid black; width: 240px"
                >
                    <div style="height: 800px">above</div>
                    <button type="button">target</button>
                    <div style="height: 800px">below</div>
                </div>
                <div style="height: 800px">below column</div>
            </div>
        </div>
    `);
    const column = page.locator("#column");
    const target = page.getByRole("button", { name: "target", exact: true });
    await wheelBoardStackTo(page, column);
    await wheelBoardStackTo(page, page.locator("#board"));
    await expect
        .poll(async () => (await column.boundingBox())!.y)
        .toBeGreaterThanOrEqual(page.viewportSize()!.height);

    await wheelColumnTo(page, column, target);

    await expect.poll(() => column.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect
        .poll(() =>
            target.evaluate((element) => {
                const box = element.getBoundingClientRect();
                const hit = document.elementFromPoint(
                    box.left + box.width / 2,
                    box.top + box.height / 2,
                );
                return hit !== null && element.contains(hit);
            }),
        )
        .toBe(true);
});

test("wheelBoardStackTo waits for a late-mounted board layout", async ({ page }) => {
    // 400px at 16px root font is below 2 * 20rem * 16px + 6px, so needsTwoPaneStack is true.
    await page.setContent(`
        <div id="placeholder">no board yet</div>
        <script>
            setTimeout(() => {
                document.getElementById("placeholder").remove();
                const layout = document.createElement("div");
                layout.setAttribute("data-board-layout", "stacked");
                layout.setAttribute("style", "width: 400px; height: 300px");
                layout.innerHTML = \`
                    <div style="height: 300px; overflow-y: auto">
                        <div style="height: 1200px">above</div>
                        <div id="bottomRight" style="height: 80px">target</div>
                    </div>
                \`;
                document.body.appendChild(layout);
            }, 300);
        </script>
    `);

    await wheelBoardStackTo(page, page.locator("#bottomRight"));

    const stack = page.locator('[data-board-layout="stacked"] > div').first();
    await expect.poll(() => stack.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    const frame = (await stack.boundingBox())!;
    await expect
        .poll(async () => {
            const current = (await page.locator("#bottomRight").boundingBox())!;
            return current.y < frame.y + frame.height - 20 && current.y + current.height > frame.y;
        })
        .toBe(true);
});

for (const host of ["analysis", "play"] as const) {
    for (const width of [1000, 800]) {
        test(`font-scaled-breakpoints: ${host} notation floor and column scrolling at ${width}px and 200%`, async ({
            page,
            mockScenario,
        }) => {
            await page.setViewportSize({ width, height: 720 });
            if (host === "analysis") {
                await mockScenario({
                    commands: filesWorkspaceCommands([[filesWorkspaceFixture.pgnFile]], {
                        ...pgnFileCommands,
                        lex_pgn: {
                            result: [
                                ...[
                                    "e4",
                                    "c5",
                                    "Nf3",
                                    "d6",
                                    "d4",
                                    "cxd4",
                                    "Nxd4",
                                    "Nf6",
                                    "Nc3",
                                    "a6",
                                    "Be3",
                                    "e5",
                                ].map((value) => ({ type: "San", value })),
                                { type: "Outcome", value: "*" },
                            ],
                        },
                    }),
                });
                await page.goto("/library");
                await page.getByRole("button", { name: "Choose collection", exact: true }).click();
                await selectFilesTreeRow(page, filesWorkspaceFixture.pgnFile.name);
                await page.getByRole("button", { name: "Open game", exact: true }).click();
                await expect(page).toHaveURL("/");
            } else {
                await page.goto("/");
                await page.getByRole("button", { name: "Play", exact: true }).click();
                await expect(
                    page.getByRole("button", { name: "Start game", exact: true }),
                ).toBeVisible();
            }
            await waitForFontsSettled(page);
            await assertNotationColumn(page, host === "analysis");
        });
    }
}

test("font-scaled-breakpoints: conversion Cancel remains reachable at 320px and 200%", async ({
    page,
    mockScenario,
    emitTauriEvent,
    capture,
    assertNoHorizontalOverflow,
}) => {
    await page.setViewportSize({ width: 320, height: 900 });
    const sourceName =
        "a-very-long-local-PGN-source-without-a-short-filename-for-cancellation-layout.pgn";
    await mockScenario({
        commands: {
            ...databaseCommands("conversion-breakpoint", "conversion.db3", {
                title: databaseTitle,
                description: "",
                player_count: 0,
                event_count: 0,
                game_count: 0,
                storage_size: "0",
                indexed: false,
            }),
            issue_pgn_workspace: {
                result: {
                    handle: { id: { id: "scaled-source" }, kind: "fileWorkspace" },
                    displayName: sourceName,
                    availability: "available",
                },
            },
            count_pgn_games: { result: 100 },
            convert_pgn: { delay: 60_000, result: null },
            cancel_conversion: { delay: 60_000, result: true },
        },
    });
    await page.goto("/library");
    await page.getByRole("button").filter({ hasText: databaseTitle }).click();
    await page.getByRole("button", { name: /^add games$/i }).click();
    await expect
        .poll(async () =>
            page.evaluate(() =>
                window.__E2E_TAURI__.invocations().find((call) => call.command === "convert_pgn"),
            ),
        )
        .not.toBeUndefined();
    const progressId = await page.evaluate(
        () =>
            (
                window.__E2E_TAURI__.invocations().find((call) => call.command === "convert_pgn")!
                    .args as { progressId: string }
            ).progressId,
    );
    await emitTauriEvent({
        event: "convert-progress",
        payload: {
            id: progressId,
            imported_games: 12345,
            elapsed_ms: 2000,
            source_file_name: sourceName,
        },
    });
    const cancel = page.getByRole("button", { name: `Cancel: ${sourceName}`, exact: true });
    await expect(cancel).toBeEnabled();
    await cancel.scrollIntoViewIfNeeded();
    await assertNothingClipped(cancel, { mode: "reachable" });
    await assertNoHorizontalOverflow();
    await page.mouse.move(319, 899);
    await waitForScrollAreaScrollbarsHidden(page);
    await capture("conversion-cancel-320-200");
    await expect(page).toHaveScreenshot("conversion-cancel-320-200.png", { fullPage: true });
    await cancel.click();
    await expect(cancel).toBeDisabled();
    // Measure the settled loading state, since disabled alone does not await the transition.
    await expect(cancel.locator(".mantine-Button-inner")).toHaveCSS("opacity", "0");
    await expect(cancel.locator(".mantine-Button-loader")).toHaveCSS("opacity", "1");
    await assertNothingClipped(cancel, { mode: "reachable" });
    await page.mouse.move(319, 899);
    await waitForScrollAreaScrollbarsHidden(page);
    await capture("conversion-cancel-pending-320-200");
    await expect(page).toHaveScreenshot("conversion-cancel-pending-320-200.png", {
        fullPage: true,
    });
});

test("font-scaled-breakpoints: visible library open controls wrap at 320px and 200%", async ({
    page,
    mockScenario,
    capture,
    assertNoHorizontalOverflow,
}) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await mockScenario({
        commands: filesWorkspaceCommands([[gameOpeningFixture.file]], gameOpeningCommands),
    });
    await page.goto("/library");
    const databaseOpen = page.getByRole("button", { name: "Open database", exact: true });
    await expect(databaseOpen).toBeEnabled();
    await waitForFontsSettled(page);
    await databaseOpen.scrollIntoViewIfNeeded();
    await assertNothingClipped(databaseOpen);
    await capture("database-open-320-200");
    await expect(page).toHaveScreenshot("database-open-320-200.png", { fullPage: true });
    await databaseOpen.click();
    const secondGame = page.getByRole("row").filter({ hasText: "Second White" });
    await expect(secondGame).toBeVisible();
    await secondGame.click();
    await expect(secondGame).toHaveAttribute("aria-selected", "true");
    const databaseGameOpen = page.getByRole("button", { name: "Open game", exact: true });
    await expect(databaseGameOpen).toBeVisible();
    await expect(databaseGameOpen).toBeEnabled();
    await databaseGameOpen.scrollIntoViewIfNeeded();
    await assertNothingClipped(databaseGameOpen, { mode: "reachable" });

    // This database preview does not use Files' fitHeight layout. Its complete board, notation
    // and controls must remain reachable after scrolling below the selected game's opener.
    const previewBoard = page.locator(".cg-wrap");
    await previewBoard.scrollIntoViewIfNeeded();
    await expect(previewBoard, "complete compact database preview board").toBeInViewport({
        ratio: 1,
    });
    const boardBox = (await previewBoard.boundingBox())!;
    expect(
        Math.abs(boardBox.width - boardBox.height),
        "compact preview board remains square",
    ).toBeLessThanOrEqual(1);
    await expect(previewBoard.locator("piece")).toHaveCount(32);
    await assertNothingClipped(previewBoard, { mode: "reachable" });
    for (const name of ["d4", "d5"]) {
        const move = page.getByRole("button", { name, exact: true });
        await move.scrollIntoViewIfNeeded();
        await expect(move, `compact preview notation ${name}`).toBeInViewport({ ratio: 1 });
        await assertNothingClipped(move, { mode: "reachable" });
    }
    for (const name of ["Go to start", "Previous move", "Next move", "Go to end"]) {
        const control = page.getByRole("button", { name, exact: true });
        await control.scrollIntoViewIfNeeded();
        await expect(control, `compact preview control ${name}`).toBeInViewport({ ratio: 1 });
        await assertNothingClipped(control, { mode: "reachable" });
    }
    await expect
        .poll(() => whitePawnSquares(previewBoard))
        .toEqual(["a2", "b2", "c2", "d2", "e2", "f2", "g2", "h2"]);
    await page.getByRole("button", { name: "Next move", exact: true }).click();
    await expect
        .poll(() => whitePawnSquares(previewBoard))
        .toEqual(["a2", "b2", "c2", "d4", "e2", "f2", "g2", "h2"]);
    await previewBoard.scrollIntoViewIfNeeded();
    await page.mouse.move(319, 899);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await waitForScrollAreaScrollbarsHidden(page);
    await capture("database-preview-320-200");
    await expect(page).toHaveScreenshot("database-preview-320-200.png", { fullPage: true });
    await page.getByRole("button", { name: "Go to start", exact: true }).click();
    await expect
        .poll(() => whitePawnSquares(previewBoard))
        .toEqual(["a2", "b2", "c2", "d2", "e2", "f2", "g2", "h2"]);
    await databaseGameOpen.scrollIntoViewIfNeeded();
    await assertNothingClipped(databaseGameOpen, { mode: "reachable" });
    await page.mouse.move(319, 899);
    await waitForScrollAreaScrollbarsHidden(page);
    await capture("database-game-open-320-200");
    await expect(page.locator("[data-database-view]")).toHaveAttribute("data-compact", "true");
    await expect(page.locator("[data-database-view]")).toHaveCSS("overflow-y", "auto");
    await expect(page.locator("[data-database-view] .mosaic-split")).toHaveCount(0);
    await assertNoHorizontalOverflow();
    await expect(page).toHaveScreenshot("database-game-open-320-200.png", { fullPage: true });
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose collection", exact: true }).click();
    await selectFilesTreeRow(page, gameOpeningFixture.file.name);
    const gameOpen = page.getByRole("button", { name: "Open game", exact: true });
    await expect(gameOpen).toBeEnabled();
    await gameOpen.scrollIntoViewIfNeeded();
    await assertNothingClipped(gameOpen);
    await assertNoHorizontalOverflow();
    await capture("files-open-320-200");
    await expect(page).toHaveScreenshot("files-open-320-200.png", { fullPage: true });
});
const databaseScenario: MockScenario = {
    commands: databaseCommands("breakpoint-db", "breakpoint.db3", {
        title: databaseTitle,
        description: "Font scale layout proof",
        player_count: 1,
        event_count: 1,
        game_count: 0,
        storage_size: "0",
        indexed: false,
    }),
};

async function seedFontScale(page: Page, scale: 50 | 100) {
    await page.addInitScript((fontScale) => {
        localStorage.setItem("font-size", String(fontScale));
    }, scale);
}

function settingsRoot(page: Page) {
    // The heading's Group belongs directly to the outer Stack, shared by both branches.
    return page.getByRole("heading", { name: "Settings", exact: true }).locator("../..");
}

function labelledSliderControl(scope: Locator | Page, title: "Font Size" | "Volume") {
    return scope.locator(`div[aria-label="${title}"]:not([role="slider"])`);
}

async function assertSettingsLayout(page: Page, compact: boolean, { initialViewport = true } = {}) {
    const tabList = page.getByRole("tablist");
    await expect(tabList).toHaveAttribute("aria-orientation", compact ? "horizontal" : "vertical");
    if (compact) {
        await expect(settingsRoot(page)).toHaveAttribute("data-compact", "true");
        await expect
            .poll(
                () =>
                    tabList.evaluate((element) => {
                        const style = getComputedStyle(element);
                        const rowHeights = new Map<number, number>();
                        for (const tab of Array.from(element.querySelectorAll('[role="tab"]'))) {
                            const tabStyle = getComputedStyle(tab);
                            // Measure the label and section, since the tab box can stretch.
                            const childBoxes = Array.from(tab.children, (child) =>
                                child.getBoundingClientRect(),
                            );
                            const intrinsicHeight =
                                Math.max(...childBoxes.map((box) => box.bottom)) -
                                Math.min(...childBoxes.map((box) => box.top)) +
                                parseFloat(tabStyle.paddingTop) +
                                parseFloat(tabStyle.paddingBottom) +
                                parseFloat(tabStyle.borderTopWidth) +
                                parseFloat(tabStyle.borderBottomWidth);
                            const rowTop = Math.round(tab.getBoundingClientRect().top);
                            rowHeights.set(
                                rowTop,
                                Math.max(rowHeights.get(rowTop) ?? 0, intrinsicHeight),
                            );
                        }
                        // Wrapped rows contribute their intrinsic heights plus gaps.
                        const rowGap = parseFloat(style.rowGap) || 0;
                        const tabsHeight =
                            Array.from(rowHeights.values()).reduce(
                                (sum, height) => sum + height,
                                0,
                            ) +
                            rowGap * (rowHeights.size - 1);
                        // clientHeight excludes borders and any horizontal scrollbar.
                        const contentHeight =
                            element.clientHeight -
                            parseFloat(style.paddingTop) -
                            parseFloat(style.paddingBottom);
                        return Math.abs(contentHeight - tabsHeight) <= 2 * rowHeights.size;
                    }),
                { message: "compact Settings tab list fits its tabs" },
            )
            .toBe(true);
        if (initialViewport) {
            const heading = page.getByRole("tabpanel").locator(":scope > :first-child");
            await expect
                .poll(
                    () =>
                        heading.evaluate((element) => {
                            const { top } = element.getBoundingClientRect();
                            return top >= 0 && top < window.innerHeight;
                        }),
                    { message: "compact Settings panel heading starts within the viewport" },
                )
                .toBe(true);
        }
    } else {
        await expect(settingsRoot(page)).not.toHaveAttribute("data-compact");
        await expect
            .poll(
                () =>
                    tabList.evaluate((element) =>
                        Math.abs(
                            element.getBoundingClientRect().height -
                                element.parentElement!.getBoundingClientRect().height,
                        ),
                    ),
                { message: "wide Settings tab list fills the Tabs root" },
            )
            .toBeLessThanOrEqual(1);
    }
}

async function assertSettingRow(control: Locator, compact: boolean) {
    const row = control.locator("..");
    await expect(control).toBeVisible();
    // Wrapping alone can imitate stacking without the compact CSS, so assert computed direction.
    await expect(row).toHaveCSS("flex-direction", compact ? "column" : "row");
    if (compact) {
        await expect
            .poll(() =>
                control.evaluate((element) => {
                    const rowElement = element.parentElement!;
                    const style = getComputedStyle(rowElement);
                    const copy = element.previousElementSibling!;
                    const copyBox = copy.getBoundingClientRect();
                    const textBoxes = Array.from(copy.children, (text) =>
                        text.getBoundingClientRect(),
                    );
                    const textHeight =
                        Math.max(...textBoxes.map((box) => box.bottom)) -
                        Math.min(...textBoxes.map((box) => box.top));
                    const controlBox = element.getBoundingClientRect();
                    const controlGap = controlBox.top - copyBox.bottom;
                    const contentWidth =
                        rowElement.getBoundingClientRect().width -
                        parseFloat(style.borderLeftWidth) -
                        parseFloat(style.borderRightWidth) -
                        parseFloat(style.paddingLeft) -
                        parseFloat(style.paddingRight);
                    return {
                        fullWidth: Math.abs(controlBox.width - contentWidth) <= 1,
                        textBoxCount: textBoxes.length,
                        copyFitsText: Math.abs(copyBox.height - textHeight) <= 2,
                        controlFollowsCopy: Math.abs(controlGap - parseFloat(style.rowGap)) <= 2,
                    };
                }),
            )
            .toEqual({
                fullWidth: true,
                textBoxCount: 2,
                copyFitsText: true,
                controlFollowsCopy: true,
            });
    } else {
        await expect
            .poll(() =>
                control.evaluate(
                    (element) =>
                        element.getBoundingClientRect().left -
                        element.previousElementSibling!.getBoundingClientRect().right,
                ),
            )
            .toBeGreaterThanOrEqual(0);
    }
}

async function selectDatabase(page: Page) {
    await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
    await page.getByRole("button").filter({ hasText: databaseTitle }).click();
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(
        databaseTitle,
    );
}

async function assertDatabasePanes(page: Page, stacked: boolean) {
    const grid = page.locator(".mantine-SimpleGrid-root:has(> .mantine-Paper-root)");
    await expect(grid).toHaveCount(1);
    const panes = grid.locator(":scope > .mantine-Paper-root");
    await expect(panes).toHaveCount(2);
    await expect
        .poll(() =>
            panes.evaluateAll((elements) => {
                const [first, second] = elements.map((pane) => pane.getBoundingClientRect());
                return {
                    below: second.top >= first.bottom - 1,
                    beside: second.left >= first.right - 1,
                    sameLeft: Math.abs(second.left - first.left) <= 1,
                    sameTop: Math.abs(second.top - first.top) <= 1,
                    visiblePanes: [first, second].every(
                        (pane) => pane.width > 0 && pane.height > 0,
                    ),
                };
            }),
        )
        .toMatchObject(
            stacked
                ? { below: true, sameLeft: true, visiblePanes: true }
                : { beside: true, sameTop: true, visiblePanes: true },
        );
}

for (const scale of [200, 100] as const) {
    const compact = scale === 200;

    test(`font-scaled-breakpoints: Files create folder dialog at 800px and ${scale}%`, async ({
        page,
        mockScenario,
        capture,
    }) => {
        if (scale === 100) await seedFontScale(page, scale);
        await page.setViewportSize({ width: 800, height: 720 });
        await mockScenario({ commands: filesWorkspaceCommands([[]]) });
        await page.goto("/library");
        await page.getByRole("button", { name: "Choose collection", exact: true }).click();
        await page.getByRole("button", { name: "Create folder", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Create folder", exact: true });
        await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toBeFocused();
        // At this width only the scaled Files threshold makes the rendered dialog full-screen.
        if (compact) {
            await expect
                .poll(() =>
                    dialog.evaluate((element) => {
                        const box = element.getBoundingClientRect();
                        return Math.max(
                            Math.abs(box.left),
                            Math.abs(box.top),
                            Math.abs(window.innerWidth - box.right),
                            Math.abs(window.innerHeight - box.bottom),
                        );
                    }),
                )
                .toBeLessThanOrEqual(1);
        } else {
            await expect
                .poll(() =>
                    dialog.evaluate((element) => {
                        const box = element.getBoundingClientRect();
                        return Math.min(
                            box.left,
                            box.top,
                            window.innerWidth - box.right,
                            window.innerHeight - box.bottom,
                        );
                    }),
                )
                .toBeGreaterThan(1);
        }
        await assertNothingClipped(dialog);
        await capture(`files-create-folder-800px-${scale}`);
    });

    test(`font-scaled-breakpoints: open tab setting rows at ${scale}%`, async ({
        page,
        capture,
    }) => {
        if (scale === 100) await seedFontScale(page, scale);
        await page.goto("/settings");
        await assertSettingsLayout(page, compact);
        await page.getByRole("tab", { name: "Appearance", exact: true }).click();
        const panel = page.getByRole("tabpanel", { name: "Appearance", exact: true });
        await expect(panel).toBeVisible();
        const control = labelledSliderControl(panel, "Font Size");
        await assertSettingRow(control, compact);
        await control.scrollIntoViewIfNeeded();
        await assertPageNotClipped(page);
        await capture(`settings-tab-row-${scale}`);
    });

    test(`font-scaled-breakpoints: search-result setting rows at ${scale}%`, async ({
        page,
        capture,
    }) => {
        if (scale === 100) await seedFontScale(page, scale);
        await page.goto("/settings");
        await page.getByPlaceholder("Search", { exact: true }).fill("font-size");
        await expect(page.getByRole("tablist")).toHaveCount(0);
        const control = labelledSliderControl(page, "Font Size");
        // This branch runs independently, so removing shared compact rules reports its own failure.
        await assertSettingRow(control, compact);
        if (compact) await expect(settingsRoot(page)).toHaveAttribute("data-compact", "true");
        await assertPageNotClipped(page);
        await capture(`settings-search-row-${scale}`);
    });

    test(`font-scaled-breakpoints: database panes at ${scale}%`, async ({
        page,
        mockScenario,
        capture,
    }) => {
        if (scale === 100) await seedFontScale(page, scale);
        await mockScenario(databaseScenario);
        await page.goto("/library");
        await selectDatabase(page);
        await assertDatabasePanes(page, compact);
        await assertPageNotClipped(page);
        await capture(`database-panes-${scale}`);
    });
}

test("font-scaled-breakpoints: volume search card is unclipped at 200%", async ({
    page,
    capture,
}) => {
    await page.goto("/settings");
    await page.getByPlaceholder("Search", { exact: true }).fill("volume");
    await expect(page.getByRole("tablist")).toHaveCount(0);
    const control = labelledSliderControl(page, "Volume");
    await assertSettingRow(control, true);
    await expect(control.getByRole("slider", { name: "Volume", exact: true })).toBeVisible();
    await expect(control.locator(".mantine-Slider-markLabel")).toHaveText(["20%", "50%", "80%"]);
    await expect(settingsRoot(page)).toHaveAttribute("data-compact", "true");
    await assertPageNotClipped(page);
    await capture("settings-volume-search-200");
});

test("font-scaled-breakpoints: Settings stays vertical at 50% and 700px", async ({
    page,
    capture,
}) => {
    await seedFontScale(page, 50);
    await page.setViewportSize({ width: 700, height: 720 });
    await page.goto("/settings");
    await assertSettingsLayout(page, false);
    await assertPageNotClipped(page);
    await capture("settings-50-700px");
});

test("font-scaled-breakpoints: live slider change stacks Settings and database panes", async ({
    page,
    mockScenario,
    capture,
}) => {
    await seedFontScale(page, 100);
    await mockScenario(databaseScenario);
    await page.goto("/settings");
    const documentStartedAt = await page.evaluate(() => performance.timeOrigin);
    await assertSettingsLayout(page, false);
    await page.getByRole("tab", { name: "Appearance", exact: true }).click();
    const slider = page.getByRole("slider", { name: "Font Size", exact: true });
    await expect(slider).toHaveAttribute("aria-valuenow", "100");
    await slider.scrollIntoViewIfNeeded();
    await capture("live-settings-100");
    // Mantine's End key commits max through onChangeEnd, the same atom update as a mouse release.
    await slider.press("End");
    await expect(slider).toHaveAttribute("aria-valuenow", "200");
    // The slider interaction already scrolled the panel, so only check the tab-list layout.
    await assertSettingsLayout(page, true, { initialViewport: false });
    await assertSettingRow(labelledSliderControl(page, "Font Size"), true);
    await assertPageNotClipped(page);
    await capture("live-settings-200");

    await page
        .locator("nav.mantine-AppShell-navbar")
        .getByRole("link", { name: "Library", exact: true })
        .click();
    await expect(page).toHaveURL("/library");
    await selectDatabase(page);
    await assertDatabasePanes(page, true);
    await assertPageNotClipped(page);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentStartedAt);
    await capture("live-database-panes-200");
});
