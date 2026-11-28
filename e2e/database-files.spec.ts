import {
    contrastRatio,
    databaseCommands,
    expect,
    filesWorkspaceCommands,
    filesWorkspaceFixture,
    paintedText,
    pgnFileCommands,
    assertButtonGlyphsUnclipped,
    assertFilesColumnsNotClipped,
    assertNothingClipped,
    selectFilesTreeRow,
    test,
    type MockScenario,
    gameOpeningFixture,
    gameOpeningCommands,
    activeWorkspaceTab,
    databaseLayoutCommands,
    playerOverviewLastGames,
    preserveStorageForReload,
    gotoPreservingStorage,
    scrollbarFreeScreenshot,
    whitePawnSquares,
    dragMosaicDivider,
    splitTextWords,
    goToBoards,
    libraryLink,
    goToLibrary,
    waitForFontsSettled,
    playBoardMove,
} from "./fixtures";
import { serializeStorageValue } from "../src/state/store/debouncedStorage";
import type { Locator, Page } from "@playwright/test";

async function openingHeaderOverlaps(tree: Locator): Promise<string[]> {
    return tree.evaluate((element) => {
        const overlaps: string[] = [];
        for (const table of element.querySelectorAll("[data-opening-moves]")) {
            const boxes: {
                text: string;
                left: number;
                right: number;
                top: number;
                bottom: number;
            }[] = [];
            for (const th of table.querySelectorAll("thead th")) {
                const cellRect = th.getBoundingClientRect();
                if (cellRect.width <= 0 || cellRect.height <= 0) continue;
                let left = Infinity;
                let right = -Infinity;
                let top = Infinity;
                let bottom = -Infinity;
                const walker = document.createTreeWalker(th, NodeFilter.SHOW_TEXT);
                while (walker.nextNode()) {
                    const node = walker.currentNode;
                    if (!node.textContent?.trim()) continue;
                    const range = document.createRange();
                    range.selectNodeContents(node);
                    for (const rect of range.getClientRects()) {
                        if (rect.width <= 0 || rect.height <= 0) continue;
                        left = Math.min(left, rect.left);
                        right = Math.max(right, rect.right);
                        top = Math.min(top, rect.top);
                        bottom = Math.max(bottom, rect.bottom);
                    }
                }
                if (left < right) {
                    boxes.push({
                        text: th.textContent?.trim() ?? "",
                        left,
                        right,
                        top,
                        bottom,
                    });
                }
            }
            for (let i = 1; i < boxes.length; i += 1) {
                const prev = boxes[i - 1];
                const curr = boxes[i];
                const sameRow =
                    Math.min(prev.bottom, curr.bottom) > Math.max(prev.top, curr.top) + 1;
                if (sameRow && prev.right > curr.left + 0.5) {
                    overlaps.push(
                        `"${prev.text}" (right=${prev.right.toFixed(1)}) overlaps "${curr.text}" (left=${curr.left.toFixed(1)})`,
                    );
                }
            }
        }
        return overlaps;
    });
}

async function openingLayout(tree: Locator) {
    const layout = await tree.evaluate((element) => {
        const bounds = (node: Element) => {
            const rect = node.getBoundingClientRect();
            return { left: rect.left, right: rect.right, width: rect.width };
        };
        const ancestors = [];
        for (let node = element.parentElement; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            ancestors.push({
                name: `${node.tagName}.${node.className}`,
                ...bounds(node),
                clipLeft: node.getBoundingClientRect().left + node.clientLeft,
                clipRight: node.getBoundingClientRect().left + node.clientLeft + node.clientWidth,
                overflowX: style.overflowX,
                scrollLeft: node.scrollLeft,
            });
        }
        const outside: string[] = [];
        const targets = [
            element,
            ...element.querySelectorAll(
                '[data-opening-recent-summary], table, .mantine-Progress-root, [data-opening-recency] [role="img"]',
            ),
        ];
        for (const node of targets) {
            const rect = bounds(node);
            const name = node === element ? "tree" : node.tagName + "." + node.className;
            if (rect.left < -1 || rect.right > innerWidth + 1)
                outside.push(`${name}: viewport ${JSON.stringify(rect)}`);
            for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
                if (getComputedStyle(ancestor).overflowX === "visible") continue;
                const left = ancestor.getBoundingClientRect().left + ancestor.clientLeft;
                const right = left + ancestor.clientWidth;
                if (rect.left < left - 1 || rect.right > right + 1)
                    outside.push(
                        `${name}: clipped by ${ancestor.tagName}.${ancestor.className} ${JSON.stringify(rect)}`,
                    );
            }
        }
        const clippedLabels: string[] = [];
        for (const label of element.querySelectorAll(".mantine-Progress-label")) {
            if (!label.textContent) continue;
            if (getComputedStyle(label).visibility === "hidden") continue;
            const range = document.createRange();
            range.selectNodeContents(label);
            const text = range.getBoundingClientRect();
            const section = label.closest(".mantine-Progress-section")!.getBoundingClientRect();
            if (text.left < section.left - 1 || text.right > section.right + 1)
                clippedLabels.push(label.textContent);
        }
        const brokenNumericValues: string[] = [];
        let numericValueCount = 0;
        for (const cell of element.querySelectorAll(
            "[data-opening-moves] tbody tr td:nth-child(2), [data-opening-moves] tbody tr td:nth-child(3), [data-opening-moves] tbody tr td:nth-child(4)",
        )) {
            const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
                const node = walker.currentNode;
                const text = node.textContent?.trim();
                if (!text) continue;
                if (node.parentElement?.closest("[data-opening-column-label]")) continue;
                numericValueCount += 1;
                const range = document.createRange();
                range.selectNodeContents(node);
                const rects = [...range.getClientRects()].filter(
                    (rect) => rect.width > 0 && rect.height > 0,
                );
                if (rects.length !== 1) {
                    brokenNumericValues.push(`${text} (${rects.length} lines)`);
                }
            }
        }
        return {
            viewport: innerWidth,
            tree: bounds(element),
            card: bounds(element.closest(".mantine-Paper-root")!),
            ancestors,
            outside,
            clippedLabels,
            brokenNumericValues,
            numericValueCount,
        };
    });
    return {
        ...layout,
        brokenWords: await splitTextWords(tree.locator("th, [data-opening-column-label]")),
        headerOverlaps: await openingHeaderOverlaps(tree),
    };
}

test("database-files: player opening recency fits narrow and font-scaled Openings in both themes", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
    capture,
}) => {
    await page.clock.setFixedTime(new Date("2026-11-08T12:00:00Z"));
    const game = gameOpeningFixture.games[0];
    const recency = {
        last_played: "2026.11.01",
        year_counts: [
            { year: 2018, count: 1 },
            { year: 2019, count: 1 },
            { year: 2023, count: 2 },
            { year: 2026, count: 3 },
            { year: 2027, count: 1 },
        ],
        recent: [
            { date: "2026.11.01", game_id: 10 },
            { date: "2026.10.12", game_id: 9 },
            { date: "2026.06.05", game_id: 8 },
            { date: "2025.09.20", game_id: 7 },
        ],
    };
    await mockScenario({
        commands: {
            ...databaseLayoutCommands,
            get_progress: { result: null },
            search_position: {
                result: [
                    [
                        { move: "e4", white: 5, draw: 2, black: 1, unknown: 1, ...recency },
                        {
                            move: "d4",
                            white: 0,
                            draw: 0,
                            black: 0,
                            unknown: 2,
                            last_played: null,
                            year_counts: [],
                            recent: [],
                        },
                        {
                            move: "*",
                            white: 1,
                            draw: 0,
                            black: 0,
                            unknown: 0,
                            last_played: "2024.??.??",
                            year_counts: [{ year: 2024, count: 1 }],
                            recent: [{ date: "2026.11.07", game_id: 99 }],
                        },
                    ],
                    [game],
                ],
            },
        },
    });
    await page.goto(`/databases/${gameOpeningFixture.databaseId}`);
    for (const surface of [
        { width: 320, scale: "100", scheme: "light" },
        { width: 320, scale: "200", scheme: "dark" },
        { width: 1920, scale: "100", scheme: "dark" },
        { width: 1920, scale: "100", scheme: "light" },
    ] as const) {
        await page.evaluate(({ scale, scheme }) => {
            localStorage.setItem("font-size", scale);
            localStorage.setItem("mantine-color-scheme", scheme);
        }, surface);
        await page.emulateMedia({ colorScheme: surface.scheme });
        await page.setViewportSize({ width: surface.width, height: 1000 });
        await gotoPreservingStorage(page, `/databases/${gameOpeningFixture.databaseId}`);
        await page.getByRole("tab", { name: "Players", exact: true }).click();
        const players = page.getByRole("tabpanel", { name: "Players", exact: true });
        await players
            .locator('[data-database-pane="table"] tbody tr')
            .filter({ hasText: "First White" })
            .click();
        const preview = players.locator('[data-database-pane="preview"]');
        await preview.getByRole("tab", { name: "Openings", exact: true }).click();
        const tree = preview.locator("[data-player-opening-tree]");
        const moves = tree.locator("[data-opening-moves]");
        await expect(page.locator("html")).toHaveCSS(
            "font-size",
            surface.scale === "200" ? "32px" : "16px",
        );
        await expect(page.locator("html")).toHaveAttribute(
            "data-mantine-color-scheme",
            surface.scheme,
        );
        await expect(moves.locator("[data-opening-recency]")).toHaveCount(3);
        await expect(tree.locator("[data-opening-recent-summary]")).toHaveText(
            "Recently: e4 (4 of 4)",
        );
        const e4 = moves.locator("tbody tr").filter({ hasText: "e4" });
        await expect(e4.locator("[data-opening-recent-count]")).toHaveText("4 of 4");
        await expect(e4.locator('[data-recent-leader="true"]')).toHaveCount(1);
        await expect(
            moves
                .locator("tbody tr")
                .filter({ hasText: "d4" })
                .locator("[data-opening-recent-count]"),
        ).toHaveText("0 of 4");
        await expect(
            moves
                .locator("tbody tr")
                .filter({ hasText: "Game ended here" })
                .locator("[data-opening-recent-count]"),
        ).toHaveCount(0);
        await expect(e4.locator("[data-opening-last-played]")).toContainText("2026-11");
        await expect(e4.getByRole("img")).toHaveAttribute(
            "aria-label",
            /Before 2019: 1 of 1 game \(100%\).*2026: 3 of 3 games \(100%\), 2 without a usable year/,
        );
        await expect(e4.locator("[data-count]")).toHaveCount(9);
        await tree.evaluate((element) => {
            for (let node: HTMLElement | null = element; node; node = node.parentElement)
                node.scrollLeft = 0;
        });
        const beforeHover = await openingLayout(tree);
        await e4.locator("[data-count]").last().hover();
        await expect(page.getByRole("tooltip")).toHaveText("2026: 3 of 3 games (100%)");
        await page.mouse.move(0, 0);
        await expect(page.getByRole("tooltip")).toHaveCount(0);
        await e4.locator("[data-opening-recent-count]").hover();
        await expect(page.getByRole("tooltip")).toHaveText("100% of the last 4 games here");
        await page.mouse.move(0, 0);
        await expect(page.getByRole("tooltip")).toHaveCount(0);
        const afterHover = await openingLayout(tree);
        await tree.evaluate((element) => {
            for (let node: HTMLElement | null = element; node; node = node.parentElement)
                node.scrollLeft = 0;
        });
        const origin = await openingLayout(tree);
        await test
            .info()
            .attach(`opening-layout-${surface.width}-${surface.scale}-${surface.scheme}`, {
                body: JSON.stringify({ surface, beforeHover, afterHover, origin }, null, 2),
                contentType: "application/json",
            });
        console.log(
            JSON.stringify({
                surface,
                viewport: origin.viewport,
                tree: origin.tree,
                card: origin.card,
            }),
        );
        expect
            .soft(
                origin.ancestors.every((ancestor) => ancestor.scrollLeft === 0),
                "all horizontal scroll offsets reset after hover",
            )
            .toBe(true);
        expect(origin.numericValueCount, JSON.stringify(surface)).toBeGreaterThan(0);
        expect.soft(origin.brokenNumericValues, JSON.stringify(surface)).toEqual([]);
        expect.soft(origin.outside, JSON.stringify(surface)).toEqual([]);
        expect.soft(origin.brokenWords, JSON.stringify(surface)).toEqual([]);
        expect.soft(origin.headerOverlaps, JSON.stringify(surface)).toEqual([]);
        expect.soft(origin.clippedLabels, JSON.stringify(surface)).toEqual([]);
        await expect(
            moves
                .locator("tbody tr")
                .filter({ hasText: "Game ended here" })
                .locator("[data-opening-last-played]"),
        ).toContainText("2024");
        await assertNoHorizontalOverflow();
        const geometry = await tree.evaluate((element) => ({
            width: element.clientWidth,
            scroll: element.scrollWidth,
            tables: [...element.querySelectorAll("table")].map((table) => ({
                width: table.clientWidth,
                scroll: table.scrollWidth,
            })),
            strips: [...element.querySelectorAll('[role="img"]')].map((strip) => ({
                width: strip.getBoundingClientRect().width,
                cells: [...strip.children].map((cell) => cell.getBoundingClientRect().width),
            })),
        }));
        expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
        for (const table of geometry.tables)
            expect(table.scroll).toBeLessThanOrEqual(table.width + 1);
        for (const strip of geometry.strips) {
            expect(strip.width).toBeGreaterThan(0);
            for (const width of strip.cells) expect(width).toBeGreaterThan(0);
        }
        await capture(
            `player-openings-recency-${surface.width}-${surface.scale}-${surface.scheme}`,
        );
    }
    await expect(page).toHaveScreenshot("player-openings-recency.png", { fullPage: true });
});

for (const width of [1920, 320]) {
    test(`database-files: player opening tree previews and prepares two moves at ${width}px`, async ({
        page,
        mockScenario,
        assertNoHorizontalOverflow,
    }) => {
        await page.addInitScript(() => localStorage.setItem("font-size", "100"));
        await page.setViewportSize({ width, height: 1000 });
        const game = gameOpeningFixture.games[0];
        await mockScenario({
            commands: {
                ...databaseLayoutCommands,
                get_progress: { result: null },
                search_position: {
                    results: [
                        [
                            [
                                {
                                    move: "e4",
                                    white: 3,
                                    draw: 1,
                                    black: 1,
                                    unknown: 1,
                                    last_played: null,
                                    year_counts: [],
                                    recent: [],
                                },
                            ],
                            [game],
                        ],
                        [
                            [
                                {
                                    move: "e5",
                                    white: 3,
                                    draw: 1,
                                    black: 1,
                                    unknown: 1,
                                    last_played: null,
                                    year_counts: [],
                                    recent: [],
                                },
                            ],
                            [game],
                        ],
                    ],
                    result: [
                        [
                            {
                                move: "*",
                                white: 3,
                                draw: 1,
                                black: 1,
                                unknown: 1,
                                last_played: null,
                                year_counts: [],
                                recent: [],
                            },
                        ],
                        [game],
                    ],
                },
            },
        });
        await page.goto(`/databases/${gameOpeningFixture.databaseId}`);
        await page.getByRole("tab", { name: "Players", exact: true }).click();
        const players = page.getByRole("tabpanel", { name: "Players", exact: true });
        const table = players.locator('[data-database-pane="table"]');
        const headers = table.locator("thead");
        await expect(headers.getByRole("button", { name: /^Name(\s|$)/ })).toBeVisible();
        await expect(headers.getByRole("button", { name: /^ID(\s|$)/ })).toHaveCount(0);
        await players
            .locator('[data-database-pane="table"] tbody tr')
            .filter({ hasText: "First White" })
            .click();
        const preview = players.locator('[data-database-pane="preview"]');
        await preview.getByRole("tab", { name: "Openings", exact: true }).click();
        const tree = preview.locator("[data-player-opening-tree]");
        await expect(tree.locator("[data-opening-sequence]")).toHaveText("Start position");
        await expect(tree.locator("[data-opening-board] .cg-wrap")).toBeVisible();
        await tree.locator("[data-opening-moves] tbody tr").filter({ hasText: "e4" }).click();
        await expect(tree.locator("[data-opening-sequence]")).toHaveText("1. e4");
        await expect(tree.locator("[data-opening-board]")).toHaveAttribute("data-fen", /4P3/);
        await expect(tree.locator("[data-opening-games]")).toContainText("First Black");
        await tree.locator("[data-opening-games] tbody tr").click();
        const gamePreview = tree.locator("[data-opening-preview]");
        await expect(gamePreview.locator(".cg-wrap")).toBeVisible();
        await expect(
            gamePreview.getByRole("button", { name: "Open on board", exact: true }),
        ).toBeVisible();
        await expect(page.getByText(/Unexpected Tauri IPC command:/)).toHaveCount(0);
        await assertNoHorizontalOverflow();
        const layout = await tree.evaluate((element) => {
            const board = element.querySelector("[data-opening-board]")!.getBoundingClientRect();
            const table = element.querySelector("[data-opening-moves]")!.getBoundingClientRect();
            return {
                width: element.clientWidth,
                scroll: element.scrollWidth,
                board: {
                    x: board.x,
                    y: board.y,
                    width: board.width,
                    height: board.height,
                    bottom: board.bottom,
                },
                table: { x: table.x, y: table.y },
            };
        });
        expect(layout.scroll).toBeLessThanOrEqual(layout.width + 1);
        const clearance = await tree.evaluate((element) => {
            const panel = element.closest<HTMLElement>('[role="tabpanel"]')!;
            const style = getComputedStyle(panel);
            const padding = Number.parseFloat(style.paddingRight);
            const contentRight =
                panel.getBoundingClientRect().left + panel.clientLeft + panel.clientWidth - padding;
            return {
                padding,
                gutter: style.scrollbarGutter,
                contentRight,
                rightEdges: [
                    ...element.querySelectorAll(
                        "[data-opening-toolbar], [data-opening-moves], [data-opening-games], [data-opening-open]",
                    ),
                ].map((item) => item.getBoundingClientRect().right),
            };
        });
        expect(clearance.gutter).toBe("stable");
        // Explicit padding also protects content when an overlay scrollbar reserves no gutter.
        expect(clearance.padding).toBeGreaterThanOrEqual(20);
        expect(clearance.rightEdges).toHaveLength(4);
        for (const right of clearance.rightEdges)
            expect(right).toBeLessThanOrEqual(clearance.contentRight + 1);
        expect(Math.abs(layout.board.width - layout.board.height)).toBeLessThan(1);
        if (width === 320) expect(layout.table.y).toBeGreaterThanOrEqual(layout.board.bottom);
        if (layout.width >= 576) expect(layout.table.x).toBeGreaterThan(layout.board.x);
        await tree.locator("[data-opening-moves] tbody tr").filter({ hasText: "e5" }).click();
        await expect(tree.locator("[data-opening-sequence]")).toHaveText("1. e4 e5");
        await expect(tree.locator("[data-opening-moves]")).toContainText("Game ended here");
        // A move played on the board advances the line like a table row, also off the table.
        const openingBoard = tree.locator("[data-opening-board]");
        const boardBox = (await openingBoard.boundingBox())!;
        // Inside the card's own scroll area the board must be in view before it is clicked.
        await openingBoard.evaluate((element) => element.scrollIntoView({ block: "center" }));
        await playBoardMove(page, openingBoard.locator("cg-board"), "d2", "d4");
        await expect(tree.locator("[data-opening-sequence]")).toHaveText("1. e4 e5 2. d4");
        await tree.getByRole("button", { name: "Previous move", exact: true }).click();
        await expect(tree.locator("[data-opening-sequence]")).toHaveText("1. e4 e5");
        // Stacked above the table the board has no edge to drag.
        if (width === 320)
            await expect(
                tree.getByRole("separator", { name: "Resize board", exact: true }),
            ).toBeHidden();
        if (width === 1920) {
            // Dragging the edge handle grows the board without pushing the card sideways.
            const handle = tree.getByRole("separator", { name: "Resize board", exact: true });
            const before = Number(await handle.getAttribute("aria-valuenow"));
            const max = Number(await handle.getAttribute("aria-valuemax"));
            const grip = (await handle.boundingBox())!;
            await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
            await page.mouse.down();
            await page.mouse.move(grip.x + grip.width / 2 + 48, grip.y + grip.height / 2, {
                steps: 4,
            });
            await page.mouse.up();
            const after = Number(await handle.getAttribute("aria-valuenow"));
            expect(after).toBe(Math.min(max, before + 3));
            const grown = (await tree.locator("[data-opening-board]").boundingBox())!;
            expect(grown.width).toBeGreaterThan(boardBox.width + 40);
            await expect(tree.locator("[data-opening-board] cg-board")).toHaveCSS(
                "width",
                `${Math.round(grown.width)}px`,
            );
            await assertNoHorizontalOverflow();
            await handle.dblclick();
            await expect(handle).toHaveAttribute("aria-valuenow", "20");
        }
        const prepare = tree.getByRole("button", { name: "Prepare on board", exact: true });
        await assertButtonGlyphsUnclipped(prepare);
        await prepare.click();
        await expect(page).toHaveURL("/");
        const database = page.getByRole("tab", { name: "Database", exact: true });
        await expect(database).toHaveAttribute("aria-selected", "true");
        // The explorer opens with its header collapsed: the caption names the database.
        await expect(
            page.getByRole("button", { name: "Show database settings", exact: true }),
        ).toBeVisible();
        await expect(page.getByRole("tab", { name: "Stats", exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "e4", exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "e5", exact: true })).toBeVisible();
        const tab = await activeWorkspaceTab(page);
        expect(tab.type).toBe("analysis");
        await expect(page.getByText(/Unexpected Tauri IPC command:/)).toHaveCount(0);
    });
}

test("database-files: owner inference opens Black and a manual flip survives autosave and reopening from a stale list", async ({
    page,
    mockScenario,
}) => {
    const [blackGame, whiteGame] = gameOpeningFixture.games;
    await mockScenario({
        commands: filesWorkspaceCommands([[]], {
            ...gameOpeningCommands,
            infer_game_orientation: { results: ["black", null] },
            write_db_game: { result: "c".repeat(64) },
        }),
    });
    await page.goto(`/databases/${gameOpeningFixture.databaseId}`);
    const open = async (white: string) => {
        if (!page.url().endsWith(`/databases/${gameOpeningFixture.databaseId}`)) {
            await page.locator("nav").getByRole("link", { name: "Library", exact: true }).click();
            await expect(page).toHaveURL(`/databases/${gameOpeningFixture.databaseId}`);
        }
        await page.getByRole("row").filter({ hasText: white }).click();
        await page.getByRole("button", { name: "Open game", exact: true }).click();
        await expect(page).toHaveURL("/");
    };
    await open(blackGame.white);
    await expect(
        page.getByRole("grid", { name: "Chessboard, Black orientation", exact: true }),
    ).toBeVisible();
    expect(
        await page.evaluate(() =>
            window.__E2E_TAURI__.invocations().filter(({ command }) => command === "write_db_game"),
        ),
    ).toHaveLength(0);
    await page
        .locator("header [role='tablist'] [role='tab'][aria-selected='true'] + button")
        .click();

    await open(whiteGame.white);
    await expect(
        page.getByRole("grid", { name: "Chessboard, White orientation", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: /^Flip Board/ }).click();
    await expect(
        page.getByRole("grid", { name: "Chessboard, Black orientation", exact: true }),
    ).toBeVisible();
    await expect
        .poll(() =>
            page.evaluate(() =>
                window.__E2E_TAURI__
                    .invocations()
                    .filter(({ command }) => command === "write_db_game"),
            ),
        )
        .toEqual([
            {
                command: "write_db_game",
                args: expect.objectContaining({
                    gameId: whiteGame.id,
                    pgn: expect.stringContaining('[Orientation "black"]'),
                    expectedStamp: whiteGame.stamp,
                }),
            },
        ]);
    await page
        .locator("header [role='tablist'] [role='tab'][aria-selected='true'] + button")
        .click();
    await open(whiteGame.white);
    await expect(
        page.getByRole("grid", { name: "Chessboard, Black orientation", exact: true }),
    ).toBeVisible();
    expect(
        await page.evaluate(() =>
            window.__E2E_TAURI__
                .invocations()
                .filter(({ command }) => command === "infer_game_orientation"),
        ),
    ).toHaveLength(2);
    await expect(page.getByText(/Unexpected Tauri IPC command:/)).toHaveCount(0);
});

for (const oldRoute of ["/files", "/databases"] as const) {
    test(`database-files: ${oldRoute} redirects to Library`, async ({ page }) => {
        await page.goto(oldRoute);
        await expect(page).toHaveURL("/library");
        await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
        const nav = page.locator("nav");
        await expect(nav.getByRole("link", { name: "Library", exact: true })).toHaveCount(1);
        await expect(nav.getByRole("link", { name: /^(Files|Databases)$/ })).toHaveCount(0);
    });
}

test("database-files: unreadable saved reference stays unselected and resumes search after library revalidation", async ({
    page,
    mockScenario,
    capture,
}, testInfo) => {
    const reference = { id: { id: gameOpeningFixture.databaseId }, kind: "database" };
    await page.addInitScript((saved) => {
        localStorage.setItem("reference-database", JSON.stringify(saved));
        localStorage.setItem("font-size", "100");
    }, reference);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const commands = filesWorkspaceCommands([[]], {
        ...gameOpeningCommands,
        get_progress: { result: null },
        linked_collections_supported: { result: true },
        list_linked_collections: { result: [] },
        search_position: {
            result: [
                [
                    {
                        move: "e4",
                        white: 10,
                        black: 5,
                        draw: 2,
                        unknown: 0,
                        last_played: null,
                        year_counts: [],
                        recent: [],
                    },
                ],
                [],
            ],
        },
    });
    await mockScenario({
        commands: {
            ...commands,
            get_db_info: {
                error: {
                    tag: "backend-error",
                    category: "database",
                    message: "Unreadable reference",
                },
            },
        },
    });
    await page.goto("/library");
    // Wait for metadata admission to finish before inspecting the board's effective choice.
    await expect(page.getByRole("treeitem", { name: "opening.db3", exact: true })).toBeVisible();
    await goToBoards(page);
    await page.getByRole("button", { name: /^Analysis Board$/ }).click();
    await page.getByRole("tab", { name: "Database", exact: true }).click();
    const explorer = page.getByRole("tabpanel", { name: "Database", exact: true });
    // The database select sits in the sources bar, above the view it would otherwise vanish with.
    const picker = page.getByPlaceholder("add a database", { exact: true });
    await expect(picker).toHaveValue("");
    await expect(page.getByRole("button", { name: /^Filters: / })).toBeDisabled();
    await expect(
        explorer.getByText("No reference database selected.", { exact: true }),
    ).toHaveCount(1);
    await expect(
        explorer.getByText("No reference database selected.", { exact: true }),
    ).toBeVisible();
    await expect(explorer.getByRole("separator")).toHaveCount(0);
    const searches = () =>
        page.evaluate(() =>
            window.__E2E_TAURI__
                .invocations()
                .filter(({ command }) => command === "search_position"),
        );
    const savedChoice = () =>
        page.evaluate(() => JSON.parse(localStorage.getItem("reference-database")!));
    expect(await searches()).toHaveLength(0);
    expect(await savedChoice()).toEqual(reference);
    await expect(page.getByText(/Unexpected Tauri IPC command:/)).toHaveCount(0);
    await capture("reference-database-unavailable");
    await testInfo.attach("reference-database-unavailable.png", {
        path: testInfo.outputPath("reference-database-unavailable.png"),
        contentType: "image/png",
    });

    await page.evaluate((next) => window.__E2E_TAURI__.configure({ commands: next }), commands);
    await goToLibrary(page);
    // Choosing the existing workspace loads its files and revalidates the shared database list.
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    await expect(page.getByRole("button", { name: "Open database", exact: true })).toBeVisible();
    await goToBoards(page);
    // With a database chosen the header collapses to its caption, and both regions show.
    await expect(explorer.locator("[data-explorer-source]")).toHaveText(
        gameOpeningFixture.databaseTitle,
    );
    await expect(picker).toHaveCount(0);
    await expect(
        explorer.getByText("No reference database selected.", { exact: true }),
    ).toHaveCount(0);
    await expect.poll(async () => (await searches()).length).toBeGreaterThan(0);
    expect(
        (await searches()).every(
            ({ args }) =>
                JSON.stringify((args as { file: unknown }).file) === JSON.stringify(reference),
        ),
    ).toBe(true);
    await expect(explorer.getByText("e4", { exact: true })).toBeVisible();
    expect(await savedChoice()).toEqual(reference);
    await expect(page.getByText(/Unexpected Tauri IPC command:/)).toHaveCount(0);
});

test("database-files: the local explorer options keep their controls legible and apart", async ({
    page,
    mockScenario,
}) => {
    const reference = { id: { id: gameOpeningFixture.databaseId }, kind: "database" };
    await page.addInitScript((saved) => {
        localStorage.setItem("reference-database", JSON.stringify(saved));
        localStorage.setItem("font-size", "100");
    }, reference);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await mockScenario({
        commands: filesWorkspaceCommands([[]], {
            ...gameOpeningCommands,
            get_progress: { result: null },
            linked_collections_supported: { result: true },
            list_linked_collections: { result: [] },
            search_position: { result: [[], []] },
        }),
    });
    await page.goto("/library");
    // Choosing the workspace loads its files and admits the shared database list.
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    await expect(page.getByRole("button", { name: "Open database", exact: true })).toBeVisible();
    await goToBoards(page);
    await page.getByRole("button", { name: /^Analysis Board$/ }).click();
    await page.getByRole("tab", { name: "Database", exact: true }).click();
    await page.getByRole("button", { name: "Show database settings", exact: true }).click();
    await expect(page.getByPlaceholder("add a database", { exact: true })).toHaveValue(
        gameOpeningFixture.databaseTitle,
    );
    await expect(page.getByRole("tab", { name: "Options", exact: true })).toHaveCount(0);
    const filterButton = page.getByRole("button", { name: "Filters: No filter", exact: true });
    await filterButton.click();
    const options = page.locator("[data-explorer-filters]");
    await page.keyboard.press("Escape");
    await expect(options).toHaveCount(0);
    await filterButton.click();

    // The colour only says which side the selected player has.
    await expect(options.getByText("Plays as", { exact: true })).toBeVisible();
    const colour = options.getByRole("radio", { name: "White", exact: true });
    await expect(colour).toBeDisabled();
    await expect(
        options.locator(".mantine-SegmentedControl-label[data-disabled]").first(),
    ).toHaveCSS("cursor", "not-allowed");

    const toggle = options.getByRole("switch", {
        name: "Exclude blitz, bullet, and armageddon events",
        exact: true,
    });
    await toggle.scrollIntoViewIfNeeded();
    const layout = await options.evaluate((panel) => {
        const box = (selector: string) =>
            [...panel.querySelectorAll(selector)].map((node) => node.getBoundingClientRect());
        const marks = box(".mantine-RangeSlider-markLabel");
        const track = panel.querySelector<HTMLElement>(".mantine-Switch-track")!;
        return {
            markCount: marks.length,
            marksBottom: Math.max(...marks.map((mark) => mark.bottom)),
            marksRight: Math.max(...marks.map((mark) => mark.right)),
            switchTop: box(".mantine-Switch-root")[0].top,
            viewportRight: panel.getBoundingClientRect().right,
            sidewaysOverflow: panel.scrollWidth - panel.clientWidth,
            switchCursor: getComputedStyle(track).cursor,
        };
    });
    // Without marks the comparisons below would pass vacuously.
    expect(layout.markCount).toBe(3);
    expect(layout.marksBottom).toBeLessThan(layout.switchTop);
    expect(layout.marksRight).toBeLessThanOrEqual(layout.viewportRight);
    expect(layout.sidewaysOverflow).toBe(0);
    expect(layout.switchCursor).toBe("pointer");

    // Escape closes only an open DateInput calendar, and the next Escape closes the filters.
    await options.getByPlaceholder("Start date", { exact: true }).click();
    const calendar = page.locator("[data-dates-dropdown]");
    await expect(calendar).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(calendar).toBeHidden();
    await expect(options).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(options).toHaveCount(0);

    // A date picked in the popover's own calendar leaves the filters open.
    await filterButton.click();
    await options.getByPlaceholder("Start date", { exact: true }).click();
    await calendar.getByRole("button", { name: /^15 / }).first().click();
    await expect(options).toBeVisible();
    await expect(options.getByPlaceholder("Start date", { exact: true })).not.toHaveValue("");
    const activeFilter = page.getByRole("button", { name: /^Filters: since / });
    await expect(activeFilter).toBeVisible();
    await activeFilter.click();
    await expect(options).toBeHidden();

    // The position search is one setting for every local source and opens from the header.
    await page.getByRole("button", { name: "Position: Exact", exact: true }).click();
    const position = page.getByRole("dialog", { name: "Position", exact: true });
    await expect(position.getByText("Games that reached exactly this position.")).toBeVisible();
    // Both palette colours must stand out from the tile, whatever the card colour is.
    const blackPawn = position.locator(".black.pawn").last();
    await blackPawn.scrollIntoViewIfNeeded();
    await expect(blackPawn).toHaveCSS("background-color", "rgb(170, 160, 147)");
    await expect(position).toHaveScreenshot("local-explorer-options-palette.png");
    await expect(page.getByText(/Unexpected Tauri IPC command:/)).toHaveCount(0);
});

function linkedLibraryFixture() {
    const file = { ...gameOpeningFixture.file, metadata: { type: "game", tags: [] } };
    const database = { id: { id: gameOpeningFixture.databaseId }, kind: "database" };
    const id = "22222222-2222-4222-8222-222222222222";
    const locator = {
        collection: id,
        generation: "linked-generation",
        ordinal: 0,
        stamp: "1".repeat(64),
    };
    const collection = {
        id,
        name: file.name,
        file: file.handle,
        database,
        account: null,
        status: "ready",
        generation: locator.generation,
        omitted: 0,
        retiredDatabase: null,
        fetchSinceMs: null,
    };
    return { file, database, locator, collection };
}

// Find the painted boundary, rather than depending on the selection/footer DOM depth.
async function assertDatabaseCardBoundary(opener: Locator, title: string) {
    const row = opener.locator('xpath=ancestor::*[@role="treeitem"][1]');
    const selection = row.getByRole("button").filter({ hasText: title });
    await expect(selection).toHaveCount(1);
    await expect(selection.getByText(title, { exact: true })).toHaveCount(1);
    const ancestors = [
        selection,
        ...(await selection.locator("xpath=ancestor::*").all()).reverse(),
    ];
    let card: Locator | undefined;
    for (const ancestor of ancestors) {
        if (
            await ancestor.evaluate((element) => {
                const style = getComputedStyle(element);
                return ["Top", "Right", "Bottom", "Left"].every(
                    (side) =>
                        Number.parseFloat(
                            style.getPropertyValue(`border-${side.toLowerCase()}-width`),
                        ) > 0 &&
                        style.getPropertyValue(`border-${side.toLowerCase()}-style`) !== "none",
                );
            })
        ) {
            card = ancestor;
            break;
        }
    }
    expect(card, "Open database must have a containing bordered card").toBeDefined();
    const boundary = card!;
    expect(
        await boundary.evaluate((element) => element.closest('[role="treeitem"]') !== null),
    ).toBe(true);
    await expect(boundary).toContainText(title);
    await expect(boundary.getByRole("button").filter({ hasText: title })).toHaveCount(1);
    await expect(boundary.getByRole("button", { name: "Open database", exact: true })).toHaveCount(
        1,
    );
    await expect(selection.getByRole("button", { name: "Open database", exact: true })).toHaveCount(
        0,
    );
    await expect(selection.getByLabel("Reference Database", { exact: true })).toHaveCount(0);
    const favourite = boundary.getByLabel("Reference Database", { exact: true });
    await expect(favourite).toHaveCount(1);
    await expect(
        boundary.locator(
            "button :is(button, a[href], input, select, textarea, [role=button], [role=radio])",
        ),
    ).toHaveCount(0);
    const outer = (await boundary.boundingBox())!;
    for (const control of [opener, favourite]) {
        const box = (await control.boundingBox())!;
        expect(box.width).toBeGreaterThan(0);
        expect(box.height).toBeGreaterThan(0);
        expect(box.x).toBeGreaterThanOrEqual(outer.x);
        expect(box.y).toBeGreaterThanOrEqual(outer.y);
        expect(box.x + box.width).toBeLessThanOrEqual(outer.x + outer.width);
        expect(box.y + box.height).toBeLessThanOrEqual(outer.y + outer.height);
    }
    return boundary;
}

function mixedDesktopLibraryFixture() {
    const names = [
        ["Beck-Kuckling-2026-10-11", "game", 2, "Game"],
        ["Schw_Caro Kann", "repertoire", 128, "Repertoire"],
        [
            "Weiß_Königsgambit — annotated preparation for the next tournament round",
            "game",
            12480,
            "Game",
        ],
        ["Weiß_Alejechin", "puzzle", 0, "Puzzle"],
    ] as const;
    const files = names.map(([name, type, count, label], index) => ({
        ...gameOpeningFixture.file,
        name,
        handle: { ...gameOpeningFixture.file.handle, id: { id: `mixed-desktop-${index}` } },
        metadata: { type, tags: [] },
        gameCount: count,
        label,
    }));
    const { collection } = linkedLibraryFixture();
    const unavailable = {
        ...collection,
        name: "Beck-Müller-2026-10-22.pgn",
        status: "unavailable",
        database: null,
    };
    const databases = [
        {
            title: "OMCORR202609",
            id: gameOpeningFixture.databaseId,
            filename: "opening.db3",
            games: "2,356,537",
            storage: "517.21 MB",
            count: 2356537,
            bytes: "542333993",
        },
        {
            title: "Meine Partien",
            id: "mixed-masters",
            filename: "masters.db3",
            games: "116",
            storage: "320 KB",
            count: 116,
            bytes: "327680",
        },
    ];
    const producers = databases.map((database) =>
        databaseCommands(database.id, database.filename, {
            title: database.title,
            description: "Independent games database",
            game_count: database.count,
            player_count: 256,
            event_count: 32,
            storage_size: database.bytes,
            indexed: false,
        }),
    );
    return {
        files,
        databases,
        unavailable,
        scenario: {
            commands: {
                ...filesWorkspaceCommands(
                    [[filesWorkspaceFixture.openingDirectory, ...files]],
                    gameOpeningCommands,
                ),
                list_workspace_databases: {
                    result: {
                        entries: producers.flatMap(
                            (producer) =>
                                (
                                    producer.list_workspace_databases!.result as {
                                        entries: unknown[];
                                    }
                                ).entries,
                        ),
                        unread: [],
                    },
                },
                // Initial listing and the existing post-workspace revalidation use the same producer.
                get_db_info: {
                    results: [0, 1, 2, 3].flatMap(() =>
                        producers.map((producer) => producer.get_db_info!.result),
                    ),
                },
                linked_collections_supported: { result: true },
                list_linked_collections: { result: [unavailable] },
                collection_for_database: { result: null },
                clear_games: { result: null },
            },
        } satisfies MockScenario,
    };
}

const MAX_COMPACT_STATS_GAP_REM = 12;

const desktopLibrarySurfaces = [
    { width: 1280, scale: 100, scheme: "light", split: true },
    { width: 1440, scale: 100, scheme: "light", split: true },
    { width: 1920, scale: 100, scheme: "light", split: true },
    { width: 1280, scale: 200, scheme: "light", split: false },
    { width: 1440, scale: 200, scheme: "light", split: false },
    { width: 1920, scale: 200, scheme: "light", split: true },
    { width: 1440, scale: 100, scheme: "dark", split: true },
] as const;

type DesktopLibrarySurface = (typeof desktopLibrarySurfaces)[number];

async function openMixedLibrary(
    page: Page,
    mockScenario: (scenario: MockScenario) => Promise<void>,
    capture: (name: string) => Promise<void>,
    surface: DesktopLibrarySurface,
) {
    await page.addInitScript(({ scale, scheme }) => {
        localStorage.setItem("font-size", String(scale));
        localStorage.setItem("mantine-color-scheme", scheme);
    }, surface);
    await page.emulateMedia({ colorScheme: surface.scheme });
    await page.setViewportSize({ width: surface.width, height: 1000 });
    const { files, databases, unavailable, scenario } = mixedDesktopLibraryFixture();
    await mockScenario(scenario);
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", surface.scheme);
    await expect(page.locator("html")).toHaveCSS(
        "font-size",
        surface.scale === 100 ? "16px" : "32px",
    );
    const fontSizePx = await page
        .locator("html")
        .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
    const tree = page.getByRole("tree", { name: "Library", exact: true });
    await expect(page.getByRole("tree")).toHaveCount(1);
    const rows = tree.getByRole("treeitem");
    const orderedNames = [
        filesWorkspaceFixture.openingDirectory.name,
        ...files.map((file) => file.name),
        unavailable.name,
        ...databases.map((database) => database.title),
    ];
    await expect(rows).toHaveCount(orderedNames.length);
    expect(
        await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label"))),
    ).toEqual(orderedNames);
    const sections = tree.locator("h2");
    await expect(sections).toHaveCount(2);
    const assertCounts = async (fileCount: number, databaseCount: number) => {
        for (const [index, name, count] of [
            [0, "Files · E2E collection", fileCount],
            [1, "Databases", databaseCount],
        ] as const) {
            const section = sections.nth(index);
            await section.scrollIntoViewIfNeeded();
            await expect(section.getByText(name, { exact: true })).toBeVisible();
            await expect(section.getByText(String(count), { exact: true })).toBeVisible();
        }
    };
    const panes = page
        .locator(".mantine-SimpleGrid-root")
        .filter({ has: tree })
        .locator(":scope > .mantine-Paper-root");
    await expect(panes).toHaveCount(2);
    const list = panes.nth(0);
    const detail = panes.nth(1);
    const reachable = async (control: Locator) => {
        await control.scrollIntoViewIfNeeded();
        // Then bring the whole border box into view: after an earlier nearest scroll of the same
        // pane, scrollIntoViewIfNeeded can stop with a control's 2px border still outside the
        // scrollport although the pane has scroll range left.
        await control.evaluate((element) =>
            element.scrollIntoView({ block: "nearest", inline: "nearest" }),
        );
        await expect(control).toBeInViewport({ ratio: 1 });
        await assertNothingClipped(control, { mode: "reachable" });
    };
    const snapshot = async (selection: string) => {
        const name = `library-mixed-${surface.width}-${surface.scale}-${surface.scheme}-${selection}`;
        await capture(name);
        if (surface.scale === 100)
            await expect.soft(page).toHaveScreenshot(`${name}.png`, { fullPage: true });
    };
    const search = page.getByRole("textbox", { name: "Search", exact: true });
    const type = page.getByRole("textbox", { name: "File type", exact: true });
    const fileSnapshotPosition = async () => {
        await search.scrollIntoViewIfNeeded();
        if (!surface.split) await detail.scrollIntoViewIfNeeded();
    };
    return {
        files,
        databases,
        unavailable,
        fontSizePx,
        tree,
        rows,
        sections,
        assertCounts,
        search,
        type,
        panes,
        list,
        detail,
        reachable,
        snapshot,
        fileSnapshotPosition,
    };
}

type MixedLibraryContext = Awaited<ReturnType<typeof openMixedLibrary>>;

async function hoverUnselectedMixedRow(page: Page, row: Locator, width: number) {
    // Clear action-focus tooltips before auditing the actual row hover.
    await page.mouse.move(width / 2, 0);
    await row.focus();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await row.hover();
    expect(await row.evaluate((element) => element.matches(":hover"))).toBe(true);
}

async function selectMixedDirectory(context: MixedLibraryContext, page: Page) {
    await selectFilesTreeRow(page, filesWorkspaceFixture.openingDirectory.name);
    await expect(context.detail.getByText("Entries: 0", { exact: true })).toBeVisible();
}

async function selectMixedFile(context: MixedLibraryContext, page: Page) {
    const row = await selectFilesTreeRow(page, context.files[0]!.name);
    await expect(
        context.detail.getByRole("button", { name: "Open game", exact: true }),
    ).toBeEnabled();
    return row;
}

async function prepareMixedFile(
    context: MixedLibraryContext,
    page: Page,
    surface: DesktopLibrarySurface,
) {
    const { detail, reachable, fileSnapshotPosition } = context;
    await selectMixedDirectory(context, page);
    const row = await selectMixedFile(context, page);
    for (const action of await detail.getByRole("button").all()) await reachable(action);
    await row.hover();
    await page.mouse.move(surface.width / 2, 0);
    await fileSnapshotPosition();
}

async function exerciseMixedDatabases(
    context: MixedLibraryContext,
    page: Page,
    assertNoHorizontalOverflow: () => Promise<void>,
) {
    const { databases, tree, detail, reachable, fontSizePx } = context;
    for (const database of databases) {
        const row = tree.getByRole("treeitem", { name: database.title, exact: true });
        const opener = row.getByRole("button", { name: "Open database", exact: true });
        await reachable(opener);
        const card = await assertDatabaseCardBoundary(opener, database.title);
        await expect(card.getByText(database.games, { exact: true })).toBeVisible();
        await expect(card.getByText(database.storage, { exact: true })).toBeVisible();
        const games = (await card.getByText(database.games, { exact: true }).boundingBox())!;
        const storage = (await card.getByText(database.storage, { exact: true }).boundingBox())!;
        expect(storage.x - games.x, "Stats must stay compact inside the card").toBeLessThanOrEqual(
            MAX_COMPACT_STATS_GAP_REM * fontSizePx,
        );
        // Stacked cards label their stats; one-line rows move the captions into the section header.
        const captions = (await card.getByText("Games", { exact: true }).isVisible())
            ? card
            : tree.locator("[data-section='databases'] [data-library-columns]");
        for (const caption of ["Games", "Storage"])
            await expect(captions.getByText(caption, { exact: true }).first()).toBeVisible();
        const favourite = card.getByLabel("Reference Database", { exact: true });
        await reachable(favourite);
        await favourite.getByRole("radio", { name: "1", exact: true }).focus();
        await favourite.getByRole("radio", { name: "1", exact: true }).press("Space");
        await expect(favourite.getByRole("radio", { name: "1", exact: true })).toBeChecked();
        await expect(page).toHaveURL("/library");
        await selectFilesTreeRow(page, database.title);
        await reachable(detail.getByRole("link", { name: "Explore", exact: true }));
        await assertNothingClipped(detail, { mode: "reachable" });
        await assertNoHorizontalOverflow();
    }
}

for (const surface of desktopLibrarySurfaces) {
    const mixedTest = test.extend<{ mixed: MixedLibraryContext }>({
        mixed: async ({ page, mockScenario, capture }, use) => {
            await use(await openMixedLibrary(page, mockScenario, capture, surface));
        },
    });
    mixedTest(
        `database-files: mixed Library files/filter/layout/selection at ${surface.width}px ${surface.scale}% ${surface.scheme}`,
        async ({ page, mixed, assertAccessible, assertNoHorizontalOverflow }, testInfo) => {
            const {
                files,
                tree,
                rows,
                list,
                detail,
                reachable,
                search,
                type,
                assertCounts,
                snapshot,
                fileSnapshotPosition,
            } = mixed;
            await assertCounts(6, 2);
            await expect(type).toHaveAccessibleName("File type");
            await expect(type).toHaveAttribute("placeholder", "All types");
            expect(
                await type.evaluate((input) =>
                    [...(input as HTMLInputElement).labels!].map((label) => label.textContent),
                ),
            ).toEqual(["File type"]);
            await search.fill(files[0]!.name);
            await expect(rows).toHaveCount(1);
            await assertCounts(1, 0);
            await search.fill("");
            await type.click();
            await page.getByRole("option", { name: "Games database", exact: true }).click();
            await expect(rows).toHaveCount(2);
            await assertCounts(0, 2);
            await page.getByRole("button", { name: "Clear type filter", exact: true }).click();
            await assertCounts(6, 2);

            const listBox = (await list.boundingBox())!;
            const detailBox = (await detail.boundingBox())!;
            if (surface.split) {
                expect(Math.abs(listBox.y - detailBox.y)).toBeLessThanOrEqual(1);
                expect(detailBox.x).toBeGreaterThanOrEqual(listBox.x + listBox.width);
                for (const pane of [list, detail]) await expect(pane).toBeInViewport({ ratio: 1 });
            } else {
                expect(Math.abs(listBox.x - detailBox.x)).toBeLessThanOrEqual(1);
                expect(detailBox.y).toBeGreaterThanOrEqual(listBox.y + listBox.height);
            }
            for (const control of [
                search,
                type,
                ...(await page
                    .getByRole("group", { name: "Add New", exact: true })
                    .getByRole("button")
                    .all()),
            ])
                await reachable(control);
            const rowGeometry = [];
            for (const file of files) {
                const row = tree.getByRole("treeitem", { name: file.name, exact: true });
                const count = row.getByText(String(file.gameCount), { exact: true });
                const badge = row.getByText(file.label, { exact: true });
                const remove = row.getByRole("button", { name: "Delete", exact: true });
                const move = row.getByRole("button", { name: "Move", exact: true });
                await reachable(row);
                await hoverUnselectedMixedRow(page, row, surface.width);
                await page.mouse.move(surface.width / 2, 0);
                const rest = await remove.evaluate((element) => getComputedStyle(element).color);
                const muted = await count.evaluate((element) => getComputedStyle(element).color);
                expect(rest, "Delete must be as quiet as row metadata at rest").toBe(muted);
                await remove.hover();
                expect(
                    await remove.evaluate((element) => getComputedStyle(element).color),
                ).not.toBe(rest);
                await page.mouse.move(surface.width / 2, 0);
                await move.focus();
                await move.press("Shift+Tab");
                await expect(remove).toBeFocused();
                expect(
                    await remove.evaluate((element) => getComputedStyle(element).color),
                ).not.toBe(rest);
                await expect(remove).toBeEnabled();
                for (const control of [count, badge, remove, move]) await reachable(control);
                rowGeometry.push({
                    count: (await count.boundingBox())!,
                    type: (await badge.boundingBox())!,
                    remove: (await remove.boundingBox())!,
                    move: (await move.boundingBox())!,
                });
            }
            for (const geometry of rowGeometry.slice(1)) {
                for (const key of ["count", "type", "remove", "move"] as const) {
                    expect(
                        Math.abs(geometry[key].x - rowGeometry[0]![key].x),
                        `${key} column must align independently of file-name length`,
                    ).toBeLessThanOrEqual(1);
                }
            }

            const positions = async () =>
                rows.evaluateAll((nodes) =>
                    nodes.map((node) => ({
                        name: node.getAttribute("aria-label"),
                        x: node.getBoundingClientRect().x,
                        y: node.getBoundingClientRect().y,
                    })),
                );
            await selectMixedDirectory(mixed, page);
            // In split mode the list has its own scroller, so detail height cannot move any row.
            const before = await positions();
            const shortDetailHeight = (await detail.locator(":scope > *").first().boundingBox())!
                .height;
            const selectedFileRow = await selectMixedFile(mixed, page);
            if (surface.split) {
                expect(await positions()).toEqual(before);
            }
            const fileDetailHeight = (await detail.locator(":scope > *").first().boundingBox())!
                .height;
            expect(
                fileDetailHeight,
                "The stationary-list check must exercise different detail heights",
            ).toBeGreaterThan(shortDetailHeight);
            const record = {
                shortDetailHeight,
                fileDetailHeight,
                before,
                after: await positions(),
            };
            await testInfo.attach("selection-geometry.json", {
                body: JSON.stringify(record, null, 2),
                contentType: "application/json",
            });
            for (const action of await detail.getByRole("button").all()) await reachable(action);
            await assertNothingClipped(list, { mode: "reachable" });
            await assertNothingClipped(detail, { mode: "reachable" });
            await assertNoHorizontalOverflow();
            await selectedFileRow.hover();
            expect(await selectedFileRow.evaluate((element) => element.matches(":hover"))).toBe(
                true,
            );
            // The selected fill must not wait for the pointer to leave the row.
            const rowFill = () =>
                selectedFileRow.evaluate((element) => getComputedStyle(element).backgroundColor);
            const hoveredFill = await rowFill();
            await assertAccessible();
            await page.mouse.move(surface.width / 2, 0);
            expect(await rowFill()).toBe(hoveredFill);
            await assertAccessible();
            await fileSnapshotPosition();
            await snapshot("file");
        },
    );

    mixedTest(
        `database-files: mixed Library unselected-row hover accessibility at ${surface.width}px ${surface.scale}% ${surface.scheme}`,
        async ({ page, mixed, assertAccessible }) => {
            const { files, tree, reachable } = mixed;
            for (const file of files) {
                const row = tree.getByRole("treeitem", { name: file.name, exact: true });
                await reachable(row);
                await hoverUnselectedMixedRow(page, row, surface.width);
                await assertAccessible();
            }
        },
    );

    mixedTest(
        `database-files: mixed Library databases/contained controls at ${surface.width}px ${surface.scale}% ${surface.scheme}`,
        async ({ page, mixed, assertAccessible, assertNoHorizontalOverflow }) => {
            await prepareMixedFile(mixed, page, surface);
            await exerciseMixedDatabases(mixed, page, assertNoHorizontalOverflow);
            await assertAccessible();
            await mixed.snapshot("database");
        },
    );

    mixedTest(
        `database-files: mixed Library unavailable recovery/keyboard at ${surface.width}px ${surface.scale}% ${surface.scheme}`,
        async ({ page, mixed, assertAccessible, assertNoHorizontalOverflow }) => {
            const { files, databases, unavailable, tree, list, detail, reachable, snapshot } =
                mixed;
            await prepareMixedFile(mixed, page, surface);
            await exerciseMixedDatabases(mixed, page, assertNoHorizontalOverflow);
            const warning = await selectFilesTreeRow(page, unavailable.name);
            await expect(warning).toContainText("The search index is unavailable");
            await expect(warning.getByText("Select", { exact: true })).toBeVisible();
            await expect(detail.locator("[data-linked-collection]")).toHaveAttribute(
                "data-linked-collection",
                unavailable.id,
            );
            await expect(detail.getByRole("alert")).toContainText(
                "The search index is unavailable",
            );
            await expect(
                detail.getByRole("button", { name: "Explore", exact: true }),
            ).toBeDisabled();
            for (const name of ["Rebuild search index", "Source PGN", "Use selected source"]) {
                const control =
                    name === "Source PGN"
                        ? detail.getByRole("textbox", { name, exact: true })
                        : detail.getByRole("button", { name, exact: true });
                await reachable(control);
            }
            await assertNothingClipped(list, { mode: "reachable" });
            await assertNothingClipped(detail, { mode: "reachable" });
            await assertNoHorizontalOverflow();
            await warning.hover();
            expect(await warning.evaluate((element) => element.matches(":hover"))).toBe(true);
            await assertAccessible();
            await page.mouse.move(surface.width / 2, 0);
            await assertAccessible();
            await warning.scrollIntoViewIfNeeded();
            if (!surface.split) await detail.scrollIntoViewIfNeeded();
            await snapshot("unavailable");
            // Section headings do not enter the single cross-kind arrow sequence.
            const lastFile = tree.getByRole("treeitem", { name: files.at(-1)!.name, exact: true });
            await lastFile.focus();
            await lastFile.press("ArrowDown");
            await expect(warning).toBeFocused();
            await warning.press("ArrowDown");
            const firstDatabase = tree.getByRole("treeitem", {
                name: databases[0]!.title,
                exact: true,
            });
            await expect(firstDatabase).toBeFocused();
            await firstDatabase.press("ArrowUp");
            await expect(warning).toBeFocused();
        },
    );
}

test("database-files: an unavailable-only Library offers recovery without the whole-Library empty message", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
    assertAccessible,
}) => {
    const { unavailable } = mixedDesktopLibraryFixture();
    await mockScenario({
        commands: {
            ...filesWorkspaceCommands([[]], gameOpeningCommands),
            list_workspace_databases: { result: { entries: [], unread: [] } },
            linked_collections_supported: { result: true },
            list_linked_collections: { result: [unavailable] },
        },
    });
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    const row = await selectFilesTreeRow(page, unavailable.name);
    await expect(page.getByRole("treeitem")).toHaveCount(1);
    await expect(row).toContainText("The search index is unavailable");
    await expect(
        page.getByText("Your library is empty. Create a file or add a database to get started.", {
            exact: true,
        }),
    ).toHaveCount(0);
    const detail = page.locator("[data-linked-collection]");
    for (const name of ["Rebuild search index", "Use selected source"]) {
        const action = detail.getByRole("button", { name, exact: true });
        await action.scrollIntoViewIfNeeded();
        await expect(action).toBeInViewport({ ratio: 1 });
        await assertNothingClipped(action, { mode: "reachable" });
    }
    await assertNoHorizontalOverflow();
    await assertAccessible();
});

test("database-files: fixed-coordinate file double-click stays on the requested row after a preserved original", async ({
    page,
    mockScenario,
}, testInfo) => {
    await page.addInitScript(() => localStorage.setItem("font-size", "100"));
    await page.setViewportSize({ width: 800, height: 647 });
    const { file, collection } = linkedLibraryFixture();
    const prefix = "verify-linked-a6bb7f1a-13d0-4675-a03e-29bc06a38631-";
    const names = [
        "verify-sample",
        "verify-game-opening",
        "verify-conversion-seed",
        "verify-conversion-cancellation",
        "verify-empty-opening",
        "verify-metadata",
        "verify-nags",
        "verify-practice-large",
        ...[
            "source",
            "database-original",
            "incoming",
            "exported",
            "restored-export",
            "prior-original",
            "prior-before",
            "database-choice-input",
            "database-choice-expected",
            "database-chosen",
            "database-choice-archive",
        ].map((suffix) => `${prefix}${suffix}`),
    ];
    const entries = names.sort().map((name, index) => ({
        ...file,
        name,
        handle: { ...file.handle, id: { id: `fixed-point-file-${index}` } },
        metadata: {
            type:
                name === "verify-practice-large"
                    ? "repertoire"
                    : ["source", "database-chosen", "prior-original"].some(
                            (suffix) => name === `${prefix}${suffix}`,
                        )
                      ? "game"
                      : "other",
            tags: [],
        },
        gameCount:
            name === "verify-empty-opening"
                ? 0
                : name === "verify-game-opening" ||
                    [
                        "source",
                        "incoming",
                        "exported",
                        "database-choice-input",
                        "database-choice-expected",
                        "database-chosen",
                        "database-choice-archive",
                    ].some((suffix) => name === `${prefix}${suffix}`)
                  ? 2
                  : 1,
    }));
    const originalFile = entries.find((entry) => entry.name === `${prefix}prior-original`)!;
    const requestedFile = entries.find((entry) => entry.name === "verify-nags")!;
    const collections = ["source", "database-chosen"].map((suffix, index) => {
        const source = entries.find((entry) => entry.name === `${prefix}${suffix}`)!;
        return {
            ...collection,
            id: index === 0 ? collection.id : "33333333-3333-4333-8333-333333333333",
            name: source.name,
            file: source.handle,
            database: { id: { id: `fixed-point-index-${index}` }, kind: "database" },
        };
    });
    const original = {
        ...collection,
        id: "44444444-4444-4444-8444-444444444444",
        name: originalFile.name,
        file: originalFile.handle,
        database: null,
        status: "preservedOriginal",
    };
    await mockScenario({
        commands: {
            ...filesWorkspaceCommands([entries], gameOpeningCommands),
            list_workspace_databases: { result: { entries: [], unread: [] } },
            linked_collections_supported: { result: true },
            list_linked_collections: { result: [...collections, original] },
            collection_for_database: { result: collections[0] },
        },
    });
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    await expect(page.getByRole("treeitem")).toHaveCount(entries.length);
    await selectFilesTreeRow(page, originalFile.name);
    const role = page.locator("[data-preserved-original]");
    await expect(role).toHaveAttribute("data-preserved-original", original.id);
    await expect(role).toContainText("The database version is now the active collection");
    const preview = page.locator(".mantine-Paper-root").filter({ has: role }).last();
    await expect(preview.locator(".cg-wrap")).toBeVisible();
    await expect(preview).toContainText("First White");
    await page.evaluate(
        () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
    );

    const requested = page.getByRole("treeitem", { name: requestedFile.name, exact: true });
    await expect(requested).toHaveAttribute("aria-selected", "false");
    // Match filesRowCoordinates in the actual-app verifier, including its real hit-target check.
    const point = await requested.evaluate((row) => {
        row.scrollIntoView({ block: "center" });
        const box = row.getBoundingClientRect();
        const x = Math.round(box.left + Math.min(60, box.width / 2));
        const y = Math.round(box.top + box.height / 2);
        return {
            x,
            y,
            hit: document
                .elementFromPoint(x, y)
                ?.closest('[role="treeitem"]')
                ?.getAttribute("aria-label"),
        };
    });
    expect(point.hit).toBe(requestedFile.name);
    const previousTab = await activeWorkspaceTab(page);
    const invocationStart = await page.evaluate(() => window.__E2E_TAURI__.invocations().length);
    // Observe only. Retain disconnected-row geometry and every actual target through navigation.
    const observer = await page.evaluateHandle(
        ({ name, point }) => {
            const row = [...document.querySelectorAll('[role="treeitem"]')].find(
                (node) => node.getAttribute("aria-label") === name,
            )!;
            const scrollParents: Element[] = [];
            for (let parent = row.parentElement; parent; parent = parent.parentElement) {
                if (parent.scrollHeight > parent.clientHeight) scrollParents.push(parent);
            }
            const measure = () => ({
                time: performance.now(),
                connected: row.isConnected,
                row: row.getBoundingClientRect().toJSON(),
                selected:
                    document
                        .querySelector('[role="treeitem"][aria-selected="true"]')
                        ?.getAttribute("aria-label") ?? null,
                hit:
                    document
                        .elementFromPoint(point.x, point.y)
                        ?.closest('[role="treeitem"]')
                        ?.getAttribute("aria-label") ?? null,
                scroll: scrollParents.map((parent) => ({
                    top: parent.scrollTop,
                    height: parent.scrollHeight,
                    client: parent.clientHeight,
                })),
            });
            const pre = measure();
            const events: {
                type: string;
                target: string | null;
                detail: number;
                trusted: boolean;
                x: number;
                y: number;
                geometry: ReturnType<typeof measure>;
            }[] = [];
            const frames: ReturnType<typeof measure>[] = [];
            let frame = 0;
            let started = false;
            const sample = () => {
                frames.push(measure());
                if (frames.length < 20) frame = requestAnimationFrame(sample);
            };
            const record = (event: Event) => {
                if (events.length >= 32) return;
                const mouse = event as MouseEvent;
                events.push({
                    type: event.type,
                    target:
                        (event.target as Element)
                            .closest('[role="treeitem"]')
                            ?.getAttribute("aria-label") ?? null,
                    detail: mouse.detail,
                    trusted: event.isTrusted,
                    x: mouse.clientX,
                    y: mouse.clientY,
                    geometry: measure(),
                });
                if (!started) {
                    started = true;
                    frame = requestAnimationFrame(sample);
                }
            };
            const types = ["mousedown", "mouseup", "click", "dblclick"];
            types.forEach((type) => document.addEventListener(type, record, true));
            return {
                finish: () => {
                    cancelAnimationFrame(frame);
                    types.forEach((type) => document.removeEventListener(type, record, true));
                    return { point, pre, events, frames, post: measure() };
                },
            };
        },
        { name: requestedFile.name, point },
    );
    try {
        // One viewport point, native mouse events, the verifier's established 60ms gap.
        // No locator action, scroll or geometry read may adjust the pointer between clicks.
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        await page.mouse.up();
        await page.waitForTimeout(60);
        await page.mouse.down({ clickCount: 2 });
        await page.mouse.up({ clickCount: 2 });
        await expect
            .poll(
                async () => {
                    const tab = await activeWorkspaceTab(page);
                    return { newTab: tab?.value !== previousTab?.value, origin: tab?.gameOrigin };
                },
                {
                    message:
                        "Fixed-coordinate double-click must admit verify-nags, see fixed-coordinate-geometry.json",
                },
            )
            .toMatchObject({
                newTab: true,
                origin: { kind: "file", file: { handle: requestedFile.handle }, gameNumber: 0 },
            });
        await expect(page).toHaveURL(/\/$/);
        const reads = await page.evaluate(
            (start) =>
                window.__E2E_TAURI__
                    .invocations()
                    .slice(start)
                    .filter((call) => call.command === "read_game"),
            invocationStart,
        );
        expect(
            reads.map((call) => call.args),
            "Only the requested file may be opened by this gesture",
        ).toEqual([expect.objectContaining({ file: requestedFile.handle, n: 0 })]);
    } finally {
        const geometry = await observer.evaluate((probe) => probe.finish());
        await observer.dispose();
        const invocations = await page.evaluate(
            (start) => window.__E2E_TAURI__.invocations().slice(start),
            invocationStart,
        );
        await testInfo.attach("fixed-coordinate-geometry.json", {
            body: JSON.stringify(
                { geometry, invocations, activeTab: await activeWorkspaceTab(page) },
                null,
                2,
            ),
            contentType: "application/json",
        });
        expect
            .soft(
                geometry.events
                    .filter((event) => event.type === "click")
                    .map((event) => ({
                        target: event.target,
                        detail: event.detail,
                        trusted: event.trusted,
                        x: event.x,
                        y: event.y,
                    })),
                "Both real clicks must reach verify-nags at the original viewport point",
            )
            .toEqual(
                [1, 2].map((detail) => ({
                    target: requestedFile.name,
                    detail,
                    trusted: true,
                    x: point.x,
                    y: point.y,
                })),
            );
    }
});

async function assertLinkedPlayerFields(detail: Locator) {
    const names = ["Existing player name", "Replacement player name"];
    for (const name of names) {
        const input = detail.getByRole("textbox", { name, exact: true });
        await expect(input).toHaveCount(1);
        await expect(input).toBeVisible();
        await input.evaluate((node) => {
            const field = (node as HTMLInputElement).labels?.[0]?.parentElement;
            if (!field) throw new Error("Linked player input has no associated label field");
            field.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
        });
        await expect(detail.getByText(name, { exact: true })).toBeVisible();
        const geometry = await input.evaluate((element, names) => {
            const node = element as HTMLInputElement;
            const label = node.labels![0];
            const field = label.parentElement!;
            const collection = node.closest("[data-linked-collection]")!;
            const otherInput = [...collection.querySelectorAll<HTMLInputElement>("input")].find(
                (peer) => peer !== node && names.includes(peer.labels?.[0]?.textContent ?? ""),
            );
            const save = [...collection.querySelectorAll("button")].find(
                (button) => button.textContent === "Save",
            );
            if (!otherInput || !save)
                throw new Error("Linked player fields or Save action are missing");
            const rect = (element: Element) => {
                const bounds = element.getBoundingClientRect();
                return {
                    left: bounds.left,
                    right: bounds.right,
                    top: bounds.top,
                    bottom: bounds.bottom,
                    width: bounds.width,
                    height: bounds.height,
                };
            };
            const range = document.createRange();
            range.selectNodeContents(label);
            return {
                labelText: label.textContent,
                field: rect(field),
                input: rect(node),
                label: rect(label),
                text: [...range.getClientRects()].map((bounds) => ({
                    left: bounds.left,
                    right: bounds.right,
                    top: bounds.top,
                    bottom: bounds.bottom,
                    width: bounds.width,
                    height: bounds.height,
                })),
                peers: [
                    {
                        name: otherInput.labels![0].textContent,
                        bounds: rect(otherInput.labels![0].parentElement!),
                    },
                    { name: "Save", bounds: rect(save) },
                ],
            };
        }, names);
        expect(geometry.labelText).toBe(name);
        expect(geometry.field.width, `${name} field must have width`).toBeGreaterThan(0);
        expect(geometry.field.height, `${name} field must have height`).toBeGreaterThan(0);
        expect(geometry.text.length, `${name} must render label text`).toBeGreaterThan(0);
        const boxes = [
            ...geometry.text.map((bounds, index) => ({
                kind: `label text line ${index + 1}`,
                bounds,
            })),
            { kind: "input", bounds: geometry.input },
            { kind: "label box", bounds: geometry.label },
        ];
        for (const { kind, bounds } of boxes) {
            const message = `${name} ${kind} must stay inside its own field`;
            expect(bounds.width, message).toBeGreaterThan(0);
            expect(bounds.height, message).toBeGreaterThan(0);
            expect(bounds.left, message).toBeGreaterThanOrEqual(geometry.field.left - 1);
            expect(bounds.right, message).toBeLessThanOrEqual(geometry.field.right + 1);
            expect(bounds.top, message).toBeGreaterThanOrEqual(geometry.field.top - 1);
            expect(bounds.bottom, message).toBeLessThanOrEqual(geometry.field.bottom + 1);
        }
        for (const peer of geometry.peers) {
            expect(peer.bounds.width, `${peer.name} must have width`).toBeGreaterThan(0);
            expect(peer.bounds.height, `${peer.name} must have height`).toBeGreaterThan(0);
            for (const { kind, bounds } of [{ kind: "field", bounds: geometry.field }, ...boxes]) {
                const width =
                    Math.min(bounds.right, peer.bounds.right) -
                    Math.max(bounds.left, peer.bounds.left);
                const height =
                    Math.min(bounds.bottom, peer.bounds.bottom) -
                    Math.max(bounds.top, peer.bounds.top);
                expect(width > 1 && height > 1, `${name} ${kind} must not cover ${peer.name}`).toBe(
                    false,
                );
            }
        }
    }
}

for (const surface of [
    { name: "desktop", width: 1440, scale: "100" },
    { name: "320-200", width: 320, scale: "200" },
]) {
    test(`database-files: linked PGN has one Library row and explorer results open the authoritative file at ${surface.name}`, async ({
        page,
        mockScenario,
        capture,
        assertAccessible,
        assertNoHorizontalOverflow,
    }) => {
        await page.addInitScript(
            (scale) => localStorage.setItem("font-size", scale),
            surface.scale,
        );
        await page.setViewportSize({ width: surface.width, height: 1000 });
        const { file, locator, collection } = linkedLibraryFixture();
        const first = gameOpeningFixture.games[0];
        const game = {
            pgn: `[Event "${first.event}"]\n[White "${first.white}"]\n[Black "${first.black}"]\n[Result "*"]\n\n${first.moves}`,
            stamp: locator.stamp,
            revision: locator.generation,
            present: true,
            linked: locator,
        };
        await mockScenario({
            commands: {
                ...filesWorkspaceCommands([[file]], gameOpeningCommands),
                list_workspace_databases: { result: { entries: [], unread: [] } },
                linked_collections_supported: { result: true },
                list_linked_collections: { result: [collection] },
                collection_for_database: { result: collection },
                get_games: {
                    result: {
                        data: gameOpeningFixture.games.map((record, ordinal) => ({
                            ...record,
                            linked: { ...locator, ordinal, stamp: String(ordinal + 1).repeat(64) },
                        })),
                        count: 2,
                    },
                },
                resolve_linked_game: {
                    result: {
                        locator,
                        file: file.handle,
                        name: file.name,
                        ordinal: 0,
                        purpose: "game",
                        numGames: 2,
                        game,
                    },
                },
                read_game: { result: game },
                file_revision: { result: locator.generation },
            },
        });
        await page.goto("/library");
        await page.getByRole("button", { name: "Choose folder", exact: true }).click();
        const row = page.getByRole("treeitem", { name: file.name, exact: true });
        await expect(row).toHaveCount(1);
        await row.getByText(file.name, { exact: true }).click();
        const detail = page.locator("[data-linked-collection]");
        await expect(detail).toHaveAttribute("data-linked-collection", collection.id);
        for (const name of ["Explore", "Rebuild search index", "Add Games", "Export to PGN"]) {
            const action = detail.getByRole("button", { name, exact: true });
            // Playwright's scrollIntoViewIfNeeded (Chromium's DOM.scrollIntoViewIfNeeded) can stop a
            // pixel or two short of a padded scroller's edge, so ratio 1 would measure the harness.
            await action.evaluate((element) => element.scrollIntoView({ block: "nearest" }));
            await expect(action).toBeInViewport({ ratio: 1 });
            await assertNothingClipped(action, { mode: "reachable" });
        }
        await assertLinkedPlayerFields(detail);
        await assertNothingClipped(detail, { mode: "reachable" });
        await assertButtonGlyphsUnclipped(detail);
        await assertNoHorizontalOverflow();
        await assertAccessible();
        await detail.scrollIntoViewIfNeeded();
        await capture(`library-linked-ready-${surface.name}`);
        await expect(page).toHaveScreenshot(`library-linked-ready-${surface.name}.png`, {
            fullPage: true,
        });
        await detail.getByRole("button", { name: "Explore", exact: true }).click();
        await expect(page).toHaveURL(`/databases/${gameOpeningFixture.databaseId}`);
        await page.getByRole("row").filter({ hasText: first.white }).dblclick();
        await expect(page).toHaveURL("/");
        await expect(page.locator("[data-file-freshness]")).toHaveAttribute(
            "data-file-freshness",
            /^verified:/,
        );
        expect((await activeWorkspaceTab(page))?.gameOrigin).toMatchObject({
            kind: "file",
            gameNumber: 0,
            file: { handle: file.handle },
        });
    });

    for (const status of ["missing", "unavailable"] as const) {
        test(`database-files: linked ${status} recovery is reachable at ${surface.name}`, async ({
            page,
            mockScenario,
            capture,
            assertNoHorizontalOverflow,
            assertAccessible,
        }) => {
            await page.addInitScript(
                (scale) => localStorage.setItem("font-size", scale),
                surface.scale,
            );
            await page.setViewportSize({ width: surface.width, height: 1000 });
            const { file, collection } = linkedLibraryFixture();
            const replacement = {
                ...file,
                handle: { ...file.handle, id: { id: "replacement-source" } },
                name: "Reselected source",
            };
            const unavailable = { ...collection, status, database: null };
            const base = {
                ...filesWorkspaceCommands([[replacement]], gameOpeningCommands),
                list_workspace_databases: { result: { entries: [], unread: [] } },
                linked_collections_supported: { result: true },
                list_linked_collections: { result: [unavailable] },
                collection_for_database: { result: unavailable },
                rebuild_linked_collection: { result: unavailable },
                reselect_linked_collection: { result: { ...collection, file: replacement.handle } },
            };
            await mockScenario({ commands: base });
            await page.goto("/library");
            await page.getByRole("button", { name: "Choose folder", exact: true }).click();
            await selectFilesTreeRow(page, collection.name);
            const detail = page.locator("[data-linked-collection]");
            await expect(detail.getByRole("alert")).toContainText(
                "The search index is unavailable",
            );
            await expect(
                detail.getByRole("button", { name: "Explore", exact: true }),
            ).toBeDisabled();
            for (const label of ["Rebuild search index", "Use selected source"]) {
                const action = detail.getByRole("button", { name: label, exact: true });
                await action.scrollIntoViewIfNeeded();
                await expect(action).toBeInViewport({ ratio: 1 });
                await assertNothingClipped(action, { mode: "reachable" });
            }
            await assertLinkedPlayerFields(detail);
            await assertNothingClipped(detail, { mode: "reachable" });
            await assertNoHorizontalOverflow();
            await assertAccessible();
            await capture(`library-linked-${status}-${surface.name}`);
            await expect(page).toHaveScreenshot(`library-linked-${status}-${surface.name}.png`, {
                fullPage: true,
            });
            await detail.getByRole("button", { name: "Rebuild search index", exact: true }).click();
            await expect
                .poll(() =>
                    page.evaluate(
                        () =>
                            window.__E2E_TAURI__
                                .invocations()
                                .filter((call) => call.command === "rebuild_linked_collection")
                                .length,
                    ),
                )
                .toBe(1);
            await detail.getByRole("textbox", { name: "Source PGN", exact: true }).click();
            await page.getByRole("option", { name: replacement.name, exact: true }).click();
            await page.evaluate((commands) => window.__E2E_TAURI__.configure({ commands }), {
                ...base,
                list_linked_collections: { result: [{ ...collection, file: replacement.handle }] },
                collection_for_database: { result: { ...collection, file: replacement.handle } },
            });
            await detail.getByRole("button", { name: "Use selected source", exact: true }).click();
            await selectFilesTreeRow(page, replacement.name);
            await expect(
                page
                    .locator("[data-linked-collection]")
                    .getByRole("button", { name: "Explore", exact: true }),
            ).toBeEnabled();
            const call = await page.evaluate(() =>
                window.__E2E_TAURI__
                    .invocations()
                    .find((entry) => entry.command === "reselect_linked_collection"),
            );
            expect(call?.args).toMatchObject({
                collection: collection.id,
                workspace: filesWorkspaceFixture.workspace,
                source: replacement.handle,
            });
            await assertLinkedPlayerFields(detail);
            await assertNoHorizontalOverflow();
            await capture(`library-linked-${status}-recovered-${surface.name}`);
            await expect(page).toHaveScreenshot(
                `library-linked-${status}-recovered-${surface.name}.png`,
                { fullPage: true },
            );
        });
    }

    test(`database-files: Database choice preserves the prior preview and leaves one active version at ${surface.name}`, async ({
        page,
        mockScenario,
        capture,
        assertNoHorizontalOverflow,
        assertAccessible,
    }) => {
        await page.addInitScript(
            (scale) => localStorage.setItem("font-size", scale),
            surface.scale,
        );
        await page.setViewportSize({ width: surface.width, height: 1000 });
        const { file, collection } = linkedLibraryFixture();
        const original = {
            ...collection,
            database: { id: { id: "original-index" }, kind: "database" },
        };
        const chosenFile = {
            ...file,
            handle: { ...file.handle, id: { id: "database-chosen-source" } },
            name: "Chosen database version",
        };
        const chosen = {
            ...collection,
            id: "33333333-3333-4333-8333-333333333333",
            name: chosenFile.name,
            file: chosenFile.handle,
            database: { id: { id: "chosen-index" }, kind: "database" },
            retiredDatabase: collection.database,
        };
        const base = {
            ...filesWorkspaceCommands([[file]], gameOpeningCommands),
            linked_collections_supported: { result: true },
            list_linked_collections: { result: [original] },
            collection_for_database: { result: original },
            migrate_linked_collection: { result: chosen },
        };
        await mockScenario({ commands: base });
        await page.goto("/library");
        await page.getByRole("button", { name: "Choose folder", exact: true }).click();
        await selectFilesTreeRow(page, gameOpeningFixture.databaseTitle);
        await page.getByRole("button", { name: "Link existing collection", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Link existing collection", exact: true });
        await dialog.getByRole("textbox", { name: "Source PGN", exact: true }).click();
        await page
            .getByRole("option", { name: `${file.name} (${file.gameCount})`, exact: true })
            .click();
        await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(chosenFile.name);
        await page.evaluate((commands) => window.__E2E_TAURI__.configure({ commands }), {
            ...base,
            list_file_workspace: { result: { entries: [file, chosenFile], unread: [] } },
            list_linked_collections: {
                result: [{ ...original, status: "preservedOriginal", database: null }, chosen],
            },
            collection_for_database: { result: chosen },
        });
        await dialog.getByRole("button", { name: "Link existing collection", exact: true }).click();
        await expect(dialog).toHaveCount(0);
        const migration = await page.evaluate(() =>
            window.__E2E_TAURI__
                .invocations()
                .find((call) => call.command === "migrate_linked_collection"),
        );
        expect(migration?.args).toMatchObject({
            source: file.handle,
            choice: "database",
            destinationName: chosenFile.name,
        });
        await expect(page.getByRole("treeitem", { name: file.name, exact: true })).toHaveCount(1);
        await expect(
            page.getByRole("treeitem", { name: chosenFile.name, exact: true }),
        ).toHaveCount(1);
        await selectFilesTreeRow(page, file.name);
        const role = page.locator("[data-preserved-original]");
        await expect(role).toHaveAttribute("data-preserved-original", original.id);
        await expect(role).toContainText("Preserved original");
        await expect(role).toContainText("The database version is now the active collection");
        await expect(page.locator("[data-linked-collection]")).toHaveCount(0);
        for (const name of ["Explore", "Rebuild search index", "Add Games", "Export to PGN"])
            await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
        const board = page.locator(".cg-wrap").first();
        await board.scrollIntoViewIfNeeded();
        await expect(board).toBeVisible();
        const bounds = await board.boundingBox();
        expect(bounds?.width).toBeGreaterThan(0);
        expect(bounds?.height).toBeGreaterThan(0);
        await assertNothingClipped(board, { mode: "reachable" });
        if (surface.name === "desktop") {
            await expect(page.getByRole("button", { name: "e4", exact: true })).toBeVisible();
            await expect(page.getByRole("button", { name: "e5", exact: true })).toBeVisible();
        }
        await role.scrollIntoViewIfNeeded();
        await assertNothingClipped(role, { mode: "reachable" });
        await assertNoHorizontalOverflow();
        await assertAccessible();
        await capture(`library-migration-preserved-original-${surface.name}`);
        await expect(page).toHaveScreenshot(
            `library-migration-preserved-original-${surface.name}.png`,
            { fullPage: true },
        );
        await selectFilesTreeRow(page, chosenFile.name);
        const detail = page.locator("[data-linked-collection]");
        await expect(detail).toHaveAttribute("data-linked-collection", chosen.id);
        await expect(role).toHaveCount(0);
        const explore = detail.getByRole("button", { name: "Explore", exact: true });
        await expect(explore).toBeEnabled();
        await assertLinkedPlayerFields(detail);
        await assertNothingClipped(detail, { mode: "reachable" });
        await assertNoHorizontalOverflow();
        await assertAccessible();
        await capture(`library-migration-chosen-${surface.name}`);
        await expect(page).toHaveScreenshot(`library-migration-chosen-${surface.name}.png`, {
            fullPage: true,
        });
    });

    test(`database-files: explicit migration surfaces preserve source choices at ${surface.name}`, async ({
        page,
        mockScenario,
        capture,
        assertNoHorizontalOverflow,
        assertAccessible,
    }) => {
        await page.addInitScript(
            (scale) => localStorage.setItem("font-size", scale),
            surface.scale,
        );
        await page.setViewportSize({ width: surface.width, height: 1000 });
        const { file } = linkedLibraryFixture();
        await mockScenario({
            commands: {
                ...filesWorkspaceCommands([[file]], gameOpeningCommands),
                linked_collections_supported: { result: true },
                list_linked_collections: { result: [] },
                collection_for_database: { result: null },
                migrate_linked_collection: { result: null },
            },
        });
        await page.goto("/library");
        await page.getByRole("button", { name: "Choose folder", exact: true }).click();
        await selectFilesTreeRow(page, gameOpeningFixture.databaseTitle);
        await page.getByRole("button", { name: "Link existing collection", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Link existing collection", exact: true });
        await expect(dialog).toContainText("Original versions are preserved before linking");
        for (const name of ["Source PGN", "Future authoritative version", "Name"]) {
            const field = dialog.getByRole("textbox", { name, exact: true });
            await field.scrollIntoViewIfNeeded();
            await expect(field).toBeInViewport({ ratio: 1 });
            await assertNothingClipped(field, { mode: "reachable" });
        }
        await assertNothingClipped(dialog, { mode: "reachable" });
        await assertNoHorizontalOverflow();
        await assertAccessible();
        await capture(`library-migration-database-${surface.name}`);
        await expect(page).toHaveScreenshot(`library-migration-database-${surface.name}.png`, {
            fullPage: true,
        });
        await dialog.getByRole("textbox", { name: "Source PGN", exact: true }).click();
        await page
            .getByRole("option", { name: `${file.name} (${file.gameCount})`, exact: true })
            .click();
        await dialog
            .getByRole("textbox", { name: "Future authoritative version", exact: true })
            .click();
        await page.getByRole("option", { name: "Use the selected PGN", exact: true }).click();
        await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toHaveCount(0);
        for (const name of ["Link existing collection", "Keep independent versions"]) {
            const action = dialog.getByRole("button", { name, exact: true });
            await action.evaluate((node) =>
                node.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }),
            );
            await expect(action).toBeInViewport({ ratio: 1 });
            await assertNothingClipped(action, { mode: "reachable" });
        }
        await assertNoHorizontalOverflow();
        await capture(`library-migration-pgn-${surface.name}`);
        await expect(page).toHaveScreenshot(`library-migration-pgn-${surface.name}.png`, {
            fullPage: true,
        });
        await dialog
            .getByRole("button", { name: "Keep independent versions", exact: true })
            .click();
        await expect(dialog).toHaveCount(0);
        const migration = await page.evaluate(() =>
            window.__E2E_TAURI__
                .invocations()
                .find((call) => call.command === "migrate_linked_collection"),
        );
        expect(migration?.args).toMatchObject({
            database: { id: { id: gameOpeningFixture.databaseId }, kind: "database" },
            source: file.handle,
            choice: "decline",
        });
    });
}

test("database-files: mixed Library retains hierarchy, selection, type filters and cross-kind keyboard opening", async ({
    page,
    mockScenario,
    assertAccessible,
    assertNoHorizontalOverflow,
    capture,
}) => {
    await page.addInitScript(() => localStorage.setItem("font-size", "100"));
    await page.setViewportSize({ width: 1440, height: 1000 });
    const sameName = gameOpeningFixture.file.name;
    const needle = {
        ...filesWorkspaceFixture.pgnFile,
        handle: { ...filesWorkspaceFixture.pgnFile.handle, id: { id: "needle-file" } },
        name: "Needle repertoire",
        metadata: { type: "repertoire", tags: [] },
    };
    const hidden = {
        ...needle,
        handle: { ...needle.handle, id: { id: "hidden" } },
        name: "Unmatched sibling",
    };
    const folder = { ...filesWorkspaceFixture.openingDirectory, children: [needle, hidden] };
    await mockScenario({
        commands: {
            ...filesWorkspaceCommands([[folder, gameOpeningFixture.file]], gameOpeningCommands),
            ...databaseCommands(gameOpeningFixture.databaseId, "opening.db3", {
                title: sameName,
                description: "Searchable database description",
                player_count: 2,
                event_count: 2,
                game_count: 2,
                storage_size: "1024",
                indexed: false,
            }),
        },
    });
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    const tree = page.getByRole("tree", { name: "Library", exact: true });
    await expect(tree).toHaveCount(1);
    const collision = tree.getByRole("treeitem", { name: sameName, exact: true });
    await expect(collision).toHaveCount(2);
    await collision.first().getByText(sameName, { exact: true }).click();
    const openGame = page.getByRole("button", { name: "Open game", exact: true });
    await expect(openGame).toBeVisible();
    await page.getByRole("textbox", { name: "Search", exact: true }).fill("Searchable database");
    await expect(collision).toHaveCount(1);
    await expect(openGame).toBeVisible();
    await page.getByRole("textbox", { name: "Search", exact: true }).fill("");
    await collision.last().getByText(sameName, { exact: true }).click();
    await expect(openGame).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Explore", exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "File type", exact: true }).click();
    await page.getByRole("option", { name: "Repertoire", exact: true }).click();
    await expect(collision).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Explore", exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "Search", exact: true }).fill("Needle");
    const folderRow = tree.getByRole("treeitem", { name: folder.name, exact: true });
    await folderRow.getByText(folder.name, { exact: true }).click();
    await expect(tree.getByRole("treeitem", { name: needle.name, exact: true })).toBeVisible();
    await expect(tree.getByRole("treeitem", { name: hidden.name, exact: true })).toHaveCount(0);
    await page.getByRole("textbox", { name: "Search", exact: true }).fill("");
    await page.getByRole("textbox", { name: "File type", exact: true }).click();
    await page.getByRole("option", { name: "Games database", exact: true }).click();
    await expect(tree.getByRole("treeitem")).toHaveCount(1);
    await tree.getByRole("treeitem").getByText(sameName, { exact: true }).click();
    await assertAccessible();
    await assertNoHorizontalOverflow();
    const explore = page.getByRole("link", { name: "Explore", exact: true });
    const buttonBox = (await explore.boundingBox())!;
    const labelBox = (await explore.locator(".mantine-Button-label").boundingBox())!;
    const centreOffset = Math.abs(
        labelBox.y + labelBox.height / 2 - (buttonBox.y + buttonBox.height / 2),
    );
    expect(centreOffset, "Explore label must be vertically centred").toBeLessThanOrEqual(2);
    await capture("library-database-selected");
    await expect(page).toHaveScreenshot("library-database-selected.png", { fullPage: true });
    // Clear the type filter and navigate across the final file row and database peer.
    await page.getByRole("button", { name: "Clear type filter", exact: true }).click();
    await expect(collision).toHaveCount(2);
    await collision.first().focus();
    await collision.first().press("ArrowDown");
    await expect(collision.last()).toBeFocused();
    await collision.last().press("Enter");
    await expect(page).toHaveURL(`/databases/${gameOpeningFixture.databaseId}`);
});

test("database-files: database view load failure stays reachable at 320px and 200% and Retry recovers", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
    capture,
}) => {
    const clockStart = new Date("2026-10-12T00:00:00Z");
    await page.clock.install({ time: clockStart });
    // Installation alone keeps ticking. Pause before app timers can schedule SWR's retry.
    await page.clock.pauseAt(clockStart.getTime() + 1000);
    await page.addInitScript(() => localStorage.setItem("font-size", "200"));
    await page.setViewportSize({ width: 320, height: 900 });
    await mockScenario({
        commands: {
            ...gameOpeningCommands,
            list_workspace_databases: {
                ...gameOpeningCommands.list_workspace_databases,
                outcomes: [
                    {
                        error: {
                            tag: "backend-error",
                            category: "database",
                            message: "Database listing unavailable",
                        },
                    },
                ],
            },
        },
    });
    await page.goto(`/databases/${gameOpeningFixture.databaseId}`);
    await expect(page.locator("html")).toHaveCSS("font-size", "32px");
    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    const failedAt = await page.evaluate(() => Date.now());
    const message = alert.getByText("Could not load databases. Please try again.", {
        exact: true,
    });
    const retry = alert.getByRole("button", { name: "Retry", exact: true });
    const overview = alert.getByRole("link", { name: "Library", exact: true });
    for (const element of [message, retry, overview]) {
        await expect(element).toBeInViewport({ ratio: 1 });
    }
    await expect(overview).toHaveAttribute("href", "/library");
    await assertNothingClipped(alert, { mode: "reachable" });
    await assertNoHorizontalOverflow();
    const listingAttempts = () =>
        page.evaluate(
            () =>
                window.__E2E_TAURI__
                    .invocations()
                    .filter((call) => call.command === "list_workspace_databases").length,
        );
    expect(await listingAttempts()).toBe(1);
    await page.clock.runFor(2000);
    expect(await page.evaluate(() => Date.now())).toBe(failedAt + 2000);
    expect(await listingAttempts()).toBe(1);
    await expect(alert).toBeVisible();
    await capture("database-view-load-failure-320-200");
    await retry.click();
    await expect.poll(listingAttempts).toBe(2);
    await expect(alert).toHaveCount(0);
    const games = page.getByRole("tabpanel", { name: "Games", exact: true }).first();
    await expect(games).toBeVisible();
    await expect(games.getByRole("row").filter({ hasText: "Second White" })).toBeVisible();
    expect(await listingAttempts()).toBe(2);
    expect(await page.evaluate(() => Date.now())).toBe(failedAt + 2000);
});

test("database-files: bounded drag and keyboard steps share a preference across tabs, compact reflow and reload", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
    capture,
}) => {
    await page.addInitScript(() => localStorage.setItem("font-size", "100"));
    // The 3rem left rail is gone, so each 50% pane is 3rem wider and a 2000×1200
    // preview is height-limited from the start. A taller window keeps the board
    // width-limited at 50% so dragging the table to 20% still grows it.
    await page.setViewportSize({ width: 2000, height: 1280 });
    await mockScenario({ commands: databaseLayoutCommands });
    await page.goto(`/databases/${gameOpeningFixture.databaseId}`);
    await expect
        .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).fontSize))
        .toBe("16px");
    const gamesPanel = page.getByRole("tabpanel", { name: "Games", exact: true }).first();
    const layout = gamesPanel.locator("[data-database-layout]");
    const split = layout.locator(".mosaic-split");
    const root = layout.locator(".mosaic-root");
    const saved = () => page.evaluate(() => localStorage.getItem("database-table-percentage"));
    await expect(split).toHaveCount(1);
    expect(await saved()).toBeNull();
    await page.getByRole("row").filter({ hasText: "Second White" }).click();
    const board = page.locator(".cg-wrap");
    const assertPreview = async () => {
        const square = (await board.boundingBox())!;
        expect(Math.abs(square.width - square.height)).toBeLessThanOrEqual(1);
        const frame = (await page.locator("[data-preview-arrangement]").boundingBox())!;
        const metadata = (await gamesPanel
            .locator(".mantine-Paper-root:has([data-preview-arrangement])")
            .first()
            .locator("[data-game-info-fields]")
            .boundingBox())!;
        expect(frame.y).toBeGreaterThan(metadata.y + metadata.height);
        expect(square.y + square.height).toBeLessThanOrEqual(frame.y + frame.height + 1);
        for (const name of ["d4", "d5", "Go to start", "Previous move", "Next move", "Go to end"]) {
            await expect(page.getByRole("button", { name, exact: true })).toBeInViewport({
                ratio: 1,
            });
        }
        await assertNothingClipped(gamesPanel, { mode: "reachable" });
    };
    const initial = (await board.boundingBox())!.width;
    await dragMosaicDivider(page, {
        root,
        split,
        percentage: 5,
        direction: "row",
        release: false,
    });
    expect(await saved()).toBeNull();
    await page.mouse.up();
    await expect(layout).toHaveAttribute("data-percentage", "20");
    expect(Number(await saved())).toBe(20);
    await expect(page.getByRole("button", { name: "Enlarge preview", exact: true })).toBeDisabled();
    await expect.poll(async () => (await board.boundingBox())!.width).toBeGreaterThan(500);
    expect((await board.boundingBox())!.width).toBeGreaterThan(initial);
    await expect(page.locator("[data-preview-arrangement]")).toHaveAttribute(
        "data-preview-arrangement",
        "beside",
    );
    await page.getByRole("button", { name: "Next move", exact: true }).click();
    const selected = ["a2", "b2", "c2", "d4", "e2", "f2", "g2", "h2"];
    await expect.poll(() => whitePawnSquares(board)).toEqual(selected);
    for (const name of ["Go to start", "Previous move", "Next move", "Go to end"]) {
        await expect(page.getByRole("button", { name, exact: true })).toBeInViewport({ ratio: 1 });
    }
    await assertPreview();
    await page.mouse.move(1999, 1279);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await capture("database-adaptive-wide");
    await expect
        .soft(page)
        .toHaveScreenshot("database-adaptive-wide.png", { stylePath: scrollbarFreeScreenshot });
    await dragMosaicDivider(page, { root, split, percentage: 95, direction: "row" });
    await expect(layout).toHaveAttribute("data-percentage", "80");
    await expect(page.getByRole("button", { name: "Enlarge table", exact: true })).toBeDisabled();
    const enlargePreview = page.getByRole("button", { name: "Enlarge preview", exact: true });
    await page.getByRole("tab", { name: "Games", exact: true }).first().focus();
    await page.keyboard.press("Tab");
    await expect(enlargePreview).toBeFocused();
    await enlargePreview.press("Enter");
    await expect(layout).toHaveAttribute("data-percentage", "75");
    expect(await saved()).toBe("75");
    await expect(page.locator("[data-preview-arrangement]")).toHaveAttribute(
        "data-preview-arrangement",
        "below",
    );
    await expect.poll(() => whitePawnSquares(board)).toEqual(selected);
    await assertPreview();
    await page.mouse.move(1999, 1279);
    await capture("database-adaptive-tall");
    await expect
        .soft(page)
        .toHaveScreenshot("database-adaptive-tall.png", { stylePath: scrollbarFreeScreenshot });
    for (const name of ["Players", "Events", "Games"]) {
        await page.getByRole("tab", { name, exact: true }).first().click();
        await expect(page.locator("[data-database-layout]:visible")).toHaveAttribute(
            "data-percentage",
            "75",
        );
    }
    await page.setViewportSize({ width: 900, height: 900 });
    await expect
        .poll(async () => Number(await layout.getAttribute("data-percentage")))
        .toBeLessThan(75);
    expect(await saved()).toBe("75");
    expect(
        (await gamesPanel.locator('[data-database-pane="preview"]').boundingBox())!.width,
    ).toBeGreaterThanOrEqual(320);
    await page.setViewportSize({ width: 320, height: 900 });
    await expect(split).toHaveCount(0);
    expect(await saved()).toBe("75");
    await expect.poll(() => whitePawnSquares(board)).toEqual(selected);
    await page.setViewportSize({ width: 2000, height: 1280 });
    await expect(layout).toHaveAttribute("data-percentage", "75");
    await expect.poll(() => whitePawnSquares(board)).toEqual(selected);
    await preserveStorageForReload(page);
    await expect(layout).toHaveAttribute("data-percentage", "75");
    expect(await saved()).toBe("75");
    await assertNoHorizontalOverflow();
});

test.describe("database-files: labelled colour filters", () => {
    test.use({ appLocale: "de-DE", colorScheme: "dark" });

    for (const surface of [
        { name: "desktop", width: 1440, scale: "100" },
        { name: "320-200", width: 320, scale: "200" },
    ]) {
        test(`BlackWhite and Any remain legible at ${surface.name}`, async ({
            page,
            mockScenario,
            assertNoHorizontalOverflow,
        }) => {
            await page.addInitScript((scale) => {
                localStorage.setItem("font-size", scale);
                localStorage.setItem("mantine-color-scheme", "dark");
            }, surface.scale);
            await page.setViewportSize({ width: surface.width, height: 900 });
            await mockScenario({ commands: databaseLayoutCommands });
            await page.goto(`/databases/${gameOpeningFixture.databaseId}`);
            await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", "dark");
            await expect(page.locator("html")).toHaveCSS(
                "font-size",
                surface.scale === "200" ? "32px" : "16px",
            );
            const player = page.getByPlaceholder("Spieler", { exact: true });
            const opponent = page.getByPlaceholder("Gegner", { exact: true });
            await expect(player).toBeVisible();
            await expect(opponent).toBeVisible();
            const playerBox = (await player.boundingBox())!;
            const opponentBox = (await opponent.boundingBox())!;
            if (surface.name === "desktop") {
                expect(playerBox.y, "Usable fields retain one row").toBe(opponentBox.y);
            } else {
                expect(opponentBox.y, "Narrow search rows stack the fields").toBeGreaterThanOrEqual(
                    playerBox.y + playerBox.height,
                );
            }

            const assertTypingSpace = async () => {
                for (const input of [player, opponent]) {
                    const geometry = await input.evaluate((element) => {
                        const box = element.getBoundingClientRect();
                        const style = getComputedStyle(element);
                        const chip = element
                            .parentElement!.querySelector("button")!
                            .getBoundingClientRect();
                        const textLeft =
                            box.left +
                            Number.parseFloat(style.paddingLeft) +
                            Number.parseFloat(style.borderLeftWidth);
                        const textRight =
                            box.right -
                            Number.parseFloat(style.paddingRight) -
                            Number.parseFloat(style.borderRightWidth);
                        return {
                            textLeft,
                            textRight,
                            chipLeft: chip.left,
                            chipRight: chip.right,
                            inputRight: box.right,
                        };
                    });
                    expect(
                        geometry.textRight - geometry.textLeft,
                        "Each player field retains at least 40px for typing",
                    ).toBeGreaterThanOrEqual(40);
                    expect(
                        geometry.chipLeft,
                        "The chip starts after the input text area",
                    ).toBeGreaterThanOrEqual(geometry.textRight);
                    expect(geometry.chipRight).toBeLessThanOrEqual(geometry.inputRight);
                    await input.fill("Test");
                    await expect(input).toHaveValue("Test");
                    await input.fill("");
                    await input.press("Escape");
                }
            };

            const playerTrigger = page.getByRole("button", { name: /^Farbe des Spielers:/ });
            await expect(playerTrigger).toHaveAttribute("aria-haspopup", "menu");
            await expect(playerTrigger).toHaveAttribute("aria-expanded", "false");
            await player.focus();
            await page.keyboard.press("Tab");
            await expect(playerTrigger).toBeFocused();
            expect(
                await playerTrigger.evaluate((element) => element.matches(":focus-visible")),
            ).toBe(true);
            await expect(playerTrigger).not.toHaveCSS("outline-style", "none");
            expect(
                await playerTrigger.evaluate((element) =>
                    Number.parseFloat(getComputedStyle(element).outlineWidth),
                ),
            ).toBeGreaterThan(0);
            await playerTrigger.click();
            await expect(playerTrigger).toHaveAttribute("aria-expanded", "true");
            const triggerId = await playerTrigger.getAttribute("id");
            expect(triggerId).toBeTruthy();
            await expect(page.getByRole("menu")).toHaveAttribute("aria-labelledby", triggerId!);
            await page.getByRole("menuitem", { name: "Schwarz", exact: true }).click();
            // the player menu must finish closing before the opponent menu opens, or getByRole('menu') matches both
            await expect(page.getByRole("menu")).toHaveCount(0);
            await expect(
                page.getByRole("button", { name: "Farbe des Spielers: Schwarz", exact: true }),
            ).toBeVisible();
            await expect(
                page.getByRole("button", { name: "Farbe des Gegners: Weiß", exact: true }),
            ).toBeVisible();
            const chipLabel = page
                .getByRole("button", { name: "Farbe des Spielers: Schwarz", exact: true })
                .getByText("Schwarz", { exact: true });
            if (surface.name === "desktop") await expect(chipLabel).toBeVisible();
            else {
                await expect(chipLabel).toBeHidden();
                await playerTrigger.hover();
                await expect(page.getByRole("tooltip")).toHaveText("Farbe des Spielers: Schwarz");
                await expect(page.getByRole("tooltip")).toBeVisible();
                await page.mouse.move(surface.width - 1, 899);
                await expect(page.getByRole("tooltip")).toHaveCount(0);
            }
            await assertTypingSpace();
            await page
                .getByRole("button", { name: "Farbe des Gegners: Weiß", exact: true })
                .click();
            const menu = page.getByRole("menu");
            await expect(menu).toBeVisible();
            for (const side of ["white", "black", "any"]) {
                await expect(menu.locator(`[data-side="${side}"]`)).toBeVisible();
            }
            await page.mouse.move(surface.width - 1, 899);
            await expect
                .soft(page)
                .toHaveScreenshot(`database-side-blackwhite-menu-${surface.name}-de-dark.png`, {
                    stylePath: scrollbarFreeScreenshot,
                });

            await page.getByRole("menuitem", { name: "Alle", exact: true }).click();
            await expect(
                page.getByRole("button", { name: "Farbe des Spielers: Alle", exact: true }),
            ).toBeVisible();
            await expect(
                page.getByRole("button", { name: "Farbe des Gegners: Alle", exact: true }),
            ).toBeVisible();
            await expect(page.locator('button [data-side="any"]')).toHaveCount(2);
            await assertTypingSpace();
            await page.mouse.move(surface.width - 1, 899);
            await expect
                .soft(page)
                .toHaveScreenshot(`database-side-any-${surface.name}-de-dark.png`, {
                    stylePath: scrollbarFreeScreenshot,
                });
            await assertNoHorizontalOverflow();
        });
    }
});

for (const width of [320, 1250]) {
    test(`database-files: populated compact tabs remain reachable at ${width}px and 200%`, async ({
        page,
        mockScenario,
        assertNoHorizontalOverflow,
    }) => {
        await page.addInitScript(() => localStorage.setItem("font-size", "200"));
        await page.setViewportSize({ width, height: 900 });
        await mockScenario({ commands: databaseLayoutCommands });
        await page.goto(`/databases/${gameOpeningFixture.databaseId}`);
        const view = page.locator("[data-database-view]");
        await expect(view).toHaveAttribute("data-compact", "true");
        await expect(view).toHaveCSS("overflow-y", "auto");
        await expect(view.locator(".mosaic-split")).toHaveCount(0);
        if (width === 1250) {
            expect(await page.evaluate(() => matchMedia("(min-width: 72em)").matches)).toBe(true);
            expect(await view.evaluate((element) => element.clientWidth)).toBeLessThan(1286);
        }
        for (const name of ["Games", "Players", "Events"]) {
            const tab = page.getByRole("tab", { name, exact: true }).first();
            await tab.scrollIntoViewIfNeeded();
            await tab.click();
            const panel = page.getByRole("tabpanel", { name, exact: true }).first();
            const row = panel.locator('[data-database-pane="table"] tbody tr').filter({
                hasText:
                    name === "Games"
                        ? "Second White"
                        : name === "Players"
                          ? "First White"
                          : "First event",
            });
            await row.scrollIntoViewIfNeeded();
            await row.click();
            const preview = panel.locator('[data-database-pane="preview"]');
            await expect(preview).toContainText(
                name === "Games"
                    ? "Second event"
                    : name === "Players"
                      ? "First White"
                      : "First event",
            );
            if (name === "Games") {
                for (const element of [
                    preview.locator(".cg-wrap"),
                    preview.getByRole("button", { name: "d4", exact: true }),
                    ...["Go to start", "Previous move", "Next move", "Go to end", "Open game"].map(
                        (label) => preview.getByRole("button", { name: label, exact: true }),
                    ),
                ]) {
                    await element.evaluate((node) => node.scrollIntoView({ block: "center" }));
                    if (
                        width === 1250 &&
                        (await element.evaluate((node) => node.classList.contains("cg-wrap")))
                    ) {
                        for (const edge of ["start", "end"] as const) {
                            await element.evaluate(
                                (node, block) => node.scrollIntoView({ block }),
                                edge,
                            );
                            await expect
                                .poll(() =>
                                    element.evaluate((node, block) => {
                                        const view = node
                                            .closest("[data-database-view]")!
                                            .getBoundingClientRect();
                                        const board = node.getBoundingClientRect();
                                        return block === "start"
                                            ? board.top >= view.top - 1
                                            : board.bottom <= view.bottom + 1;
                                    }, edge),
                                )
                                .toBe(true);
                        }
                    } else await expect(element).toBeInViewport({ ratio: 1 });
                    await assertNothingClipped(element, { mode: "reachable" });
                }
                expect(await view.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
            } else {
                await preview.scrollIntoViewIfNeeded();
                if (name === "Players")
                    await expect(preview.locator(".recharts-surface")).not.toHaveCount(0);
                else
                    await expect(
                        preview.getByRole("row").filter({ hasText: "Second White" }),
                    ).toBeVisible();
            }
            await assertNothingClipped(panel, { mode: "reachable" });
            await assertNoHorizontalOverflow();
        }
    });
}

const { openingDirectory, pgnFile } = filesWorkspaceFixture;

test("database-files: long player metadata leaves nested preview tabs and charts reachable", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
}) => {
    const longName = `First White ${"Long ".repeat(100)}`;
    await page.addInitScript(() => localStorage.setItem("font-size", "200"));
    await page.setViewportSize({ width: 320, height: 900 });
    await mockScenario({
        commands: {
            ...databaseLayoutCommands,
            get_players: { result: { data: [{ id: 1, name: longName, elo: 1500 }], count: 1 } },
        },
    });
    await page.goto(`/databases/${gameOpeningFixture.databaseId}`);
    await page.getByRole("tab", { name: "Players", exact: true }).click();
    const panel = page.getByRole("tabpanel", { name: "Players", exact: true });
    await panel.locator('[data-database-pane="table"] tbody tr').click();
    const preview = panel.locator('[data-database-pane="preview"]');
    await expect(preview.getByText(longName, { exact: true })).toBeVisible();
    const overview = preview.getByRole("tab", { name: "Overview", exact: true });
    const label = overview.locator(".mantine-Tabs-tabLabel");
    await label.evaluate((node) => node.scrollIntoView({ block: "center" }));
    await expect(label).toBeInViewport({ ratio: 1 });
    await overview.click();
    await assertNothingClipped(overview, { mode: "reachable" });
    await expect(preview.locator(".recharts-surface")).not.toHaveCount(0);

    const headline = preview.getByTestId("overview-headline");
    await expect(headline).toContainText("1 Games");
    await expect(headline).toContainText("100%");
    await expect(headline).toContainText("+1 =0 −0");
    await expect(preview.getByTestId("overview-white")).toContainText("1 Games 100% +1 =0 −0");
    await expect(preview.getByTestId("overview-black")).toContainText("No games as Black");
    const ratings = preview.getByTestId("overview-ratings");
    await expect(ratings).toContainText("Peak: 1500");
    await expect(ratings).toContainText("Latest: 1500");
    const opponents = preview.getByTestId("overview-opponents");
    await expect(opponents).toContainText("Avg. opponent 1400 · Performance 2200 · 1 rated");
    await expect(opponents).toContainText(
        "As White: Avg. opponent 1400 · Performance 2200 · 1 rated",
    );
    const whiteOpenings = preview.getByTestId("overview-openings-white");
    await expect(whiteOpenings).toContainText("Italian Game");
    await expect(whiteOpenings).toContainText("1 100%");
    const blackOpenings = preview.getByTestId("overview-openings-black");
    await expect(blackOpenings).toBeVisible();
    await expect(blackOpenings).toHaveText("Black");

    const lastGames = preview.locator("[data-last-games]");
    await expect(lastGames.getByText("Last games", { exact: true })).toBeVisible();
    const lastGameRows = lastGames.getByRole("button");
    await expect(lastGameRows).toHaveCount(playerOverviewLastGames.length);
    await expect(lastGameRows.nth(0)).toContainText("2026.10.03");
    await expect(lastGameRows.nth(0)).toContainText("Latest Opponent (1480)");
    await expect(lastGameRows.nth(0)).toContainText(/Win(?!s)/);
    await expect(lastGameRows.nth(0)).toContainText("A20");
    await expect(lastGameRows.nth(1)).toContainText("2026.10.01");
    await expect(lastGameRows.nth(1)).toContainText("First Black (1400)");
    await expect(lastGameRows.nth(1)).toContainText(/Win(?!s)/);
    await expect(lastGameRows.nth(1)).toContainText("C50");
    await expect
        .poll(async () =>
            page.evaluate(
                () =>
                    window.__E2E_TAURI__.invocations().find((call) => {
                        if (call.command !== "get_games") return false;
                        const query = (
                            call.args as {
                                query?: {
                                    player1?: unknown;
                                    sides?: unknown;
                                    options?: {
                                        sort?: unknown;
                                        direction?: unknown;
                                        pageSize?: unknown;
                                    };
                                };
                            }
                        ).query;
                        return (
                            query?.player1 === 1 &&
                            query.sides === "Any" &&
                            query.options?.sort === "newest" &&
                            query.options?.direction === "desc" &&
                            query.options?.pageSize === 10
                        );
                    }) !== undefined,
            ),
        )
        .toBe(true);

    await assertNothingClipped(preview, { mode: "reachable" });
    await assertNoHorizontalOverflow();
});

test("database-files: short split panes retain table rows, board, notation and controls at 200%", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
}) => {
    await page.addInitScript(() => localStorage.setItem("font-size", "200"));
    await page.setViewportSize({ width: 2000, height: 720 });
    await mockScenario({ commands: databaseLayoutCommands });
    await page.goto(`/databases/${gameOpeningFixture.databaseId}`);
    const panel = page.getByRole("tabpanel", { name: "Games", exact: true }).first();
    await expect(panel.locator(".mosaic-split")).toHaveCount(1);
    await page.keyboard.press("ArrowDown");
    const preview = panel.locator('[data-database-pane="preview"]');
    const board = preview.locator(".cg-wrap");
    await expect.poll(async () => (await board.boundingBox())?.width ?? 0).toBeGreaterThan(0);
    const row = panel
        .locator('[data-database-pane="table"] tbody tr')
        .filter({ hasText: "First White" });
    const playerName = row.getByText("First White", { exact: true });
    await playerName.scrollIntoViewIfNeeded();
    await expect(playerName).toBeInViewport({ ratio: 1 });
    await assertNothingClipped(row, { mode: "reachable" });
    for (const edge of ["start", "end"] as const) {
        await board.evaluate((node, block) => node.scrollIntoView({ block }), edge);
        await expect(board).toBeInViewport();
        await assertNothingClipped(board, { mode: "reachable" });
    }
    for (const name of [
        "e4",
        "e5",
        "Go to start",
        "Previous move",
        "Next move",
        "Go to end",
        "Open game",
    ]) {
        const control = preview.getByRole("button", { name, exact: true });
        await control.evaluate((node) => node.scrollIntoView({ block: "center" }));
        await expect(control).toBeInViewport({ ratio: 1 });
        await assertNothingClipped(control, { mode: "reachable" });
    }
    await assertNoHorizontalOverflow();
});

test("database-files: real double-click on database card outer padding opens the overview", async ({
    page,
    mockScenario,
}) => {
    await page.addInitScript(() => localStorage.setItem("font-size", "100"));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await mockScenario({ commands: gameOpeningCommands });
    await page.goto("/library");
    const opener = page.getByRole("button", { name: "Open database", exact: true });
    const card = await assertDatabaseCardBoundary(opener, gameOpeningFixture.databaseTitle);
    await card.scrollIntoViewIfNeeded();
    const point = await card.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const x = box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft) / 2;
        const y = box.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop) / 2;
        return {
            x,
            y,
            hit: document.elementFromPoint(x, y) === element,
            outsideControls: [
                ...element.querySelectorAll('button, [aria-label="Reference Database"]'),
            ].every((control) => {
                const rect = control.getBoundingClientRect();
                return x < rect.left || x > rect.right || y < rect.top || y > rect.bottom;
            }),
        };
    });
    expect(point.hit, "The real pointer must hit the card's outer padding").toBe(true);
    expect(
        point.outsideControls,
        "The padding point must be outside selection and footer controls",
    ).toBe(true);
    await page.mouse.dblclick(point.x, point.y);
    await expect(page).toHaveURL(`/databases/${gameOpeningFixture.databaseId}`);
    await expect(
        page.getByRole("heading", { name: gameOpeningFixture.databaseTitle, exact: true }),
    ).toBeVisible();
});

// The preview's game info once kept a 36rem minimum inside a horizontal scroller, so a narrower
// preview hid BLACK, the Black player and Elo and part of the date (f-20261121-06). Every field must
// sit inside the preview card's width at each of the header's three layout steps. Also runs in
// WebKit.
// One load per font scale and only viewport changes after it: a reload under WebKit can cancel the
// logo request still in flight, which the page fixture reports as a failure.
for (const { scale, surfaces } of [
    { scale: "100", surfaces: [{ width: 1440, columns: 3 }] },
    {
        scale: "200",
        surfaces: [
            { width: 1400, columns: 2 },
            { width: 320, columns: 1 },
        ],
    },
] as const) {
    test(`database-files: game info fields stay inside the preview at every layout step, ${scale}%`, async ({
        page,
        mockScenario,
    }) => {
        await page.addInitScript((value) => localStorage.setItem("font-size", value), scale);
        await page.setViewportSize({ width: surfaces[0].width, height: 900 });
        await mockScenario({ commands: gameOpeningCommands });
        await page.goto(`/databases/${gameOpeningFixture.databaseId}`);
        await page.locator("tbody tr").filter({ hasText: "Second White" }).click();
        for (const surface of surfaces) {
            await page.setViewportSize({ width: surface.width, height: 900 });
            const fields = page.locator("[data-game-info-fields]");
            await expect(fields.getByRole("textbox", { name: "Black", exact: true })).toHaveValue(
                "Second Black",
            );
            const columns = () =>
                fields.evaluate(
                    (grid) => getComputedStyle(grid).gridTemplateColumns.split(" ").length,
                );
            // After a resize the compact switch follows a ResizeObserver and a React commit, so
            // measure only once the grid has reached this surface's layout step.
            if (surface !== surfaces[0]) {
                await expect
                    .poll(columns, { message: `${surface.width}px / ${scale}%` })
                    .toBe(surface.columns);
            }
            await waitForFontsSettled(page);
            const outside = await fields.evaluate((grid) => {
                const card = grid.closest(".mantine-Paper-root")!.getBoundingClientRect();
                return [...grid.querySelectorAll("input, button, span, a, p")]
                    .filter((field) => field.getBoundingClientRect().width > 0)
                    .flatMap((field) => {
                        const box = field.getBoundingClientRect();
                        // Horizontal only: the card scrolls vertically by design.
                        const inside = box.left >= card.left - 1 && box.right <= card.right + 1;
                        const name =
                            field.getAttribute("aria-label") ?? field.textContent ?? field.tagName;
                        return inside ? [] : [`${name} [${box.left}, ${box.right}]`];
                    });
            });
            expect(outside, `${surface.width}px / ${scale}%`).toEqual([]);
            expect(await columns(), `${surface.width}px / ${scale}%`).toBe(surface.columns);
        }
    });
}

for (const gesture of ["button", "double-click", "Enter"] as const) {
    test(`database-files: visible database opener and explicit game ${gesture}`, async ({
        page,
        mockScenario,
        capture,
    }) => {
        await page.setViewportSize({ width: 1400, height: 900 });
        await mockScenario({ commands: gameOpeningCommands });
        await page.goto("/library");
        const opener = page.getByRole("button", { name: "Open database", exact: true });
        await expect(opener).toHaveText("Open database");
        await assertDatabaseCardBoundary(opener, gameOpeningFixture.databaseTitle);
        await expect(opener.locator("button")).toHaveCount(0);
        await capture("database-labelled-opener");
        await expect(page).toHaveScreenshot("database-labelled-opener.png", { fullPage: true });
        await opener.click();
        await expect(page).toHaveURL(`/databases/${gameOpeningFixture.databaseId}`);
        const rows = page.locator("tbody tr");
        const second = rows.filter({ hasText: "Second White" });
        const openGame = page.getByRole("button", { name: "Open game", exact: true });
        await expect(openGame).toBeDisabled();
        if (gesture === "button") {
            await second.click();
            await expect(page).toHaveURL(`/databases/${gameOpeningFixture.databaseId}`);
            await expect(second).toHaveAttribute("aria-selected", "true");
            await expect(openGame).toBeEnabled();
            await expect(openGame).toHaveText("Open game");
            await page.mouse.move(1399, 899);
            await capture("database-labelled-game");
            await expect(page).toHaveScreenshot("database-labelled-game.png", {
                fullPage: true,
                stylePath: scrollbarFreeScreenshot,
            });
            await openGame.click();
        } else if (gesture === "double-click") await second.dblclick();
        else {
            await second.focus();
            await second.press("Enter");
        }
        await expect(page).toHaveURL(/\/$/);
        await expect(page.getByRole("tab", { name: /Second White - Second Black/ })).toBeVisible();
        expect((await activeWorkspaceTab(page))?.gameOrigin).toEqual({
            kind: "database",
            database: { id: { id: gameOpeningFixture.databaseId }, kind: "database" },
            gameId: 202,
        });
        await expect(page.getByRole("button", { name: "d4", exact: true })).toBeVisible();
    });
}

test("database-files: metadata-only editing fits 320px and relists the chosen type", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
    assertAccessible,
}) => {
    await page.setViewportSize({ width: 320, height: 900 });
    const initial = { ...pgnFile, metadata: { type: "other", tags: ["keep"] } };
    const edited = { ...initial, metadata: { type: "repertoire", tags: ["keep"] } };
    await mockScenario({
        commands: filesWorkspaceCommands([[initial], [edited]], {
            ...pgnFileCommands,
            write_workspace_file_metadata: { result: null },
        }),
    });
    await page.goto("/library");
    await page.getByRole("button", { name: /choose folder/i }).click();
    await selectFilesTreeRow(page, initial.name);
    await page.getByRole("button", { name: "Edit metadata", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Edit metadata", exact: true });
    const name = dialog.getByRole("textbox", { name: "Name", exact: true });
    await expect(name).toBeFocused();
    await expect(name).toHaveValue(initial.name);
    await dialog.getByRole("textbox", { name: /file type/i }).click();
    await page.getByRole("option", { name: "Repertoire", exact: true }).click();
    await assertNoHorizontalOverflow();
    await assertNothingClipped(dialog);
    await assertAccessible();
    await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(
        page.getByRole("treeitem").locator(".mantine-Badge-root").filter({ hasText: "Repertoire" }),
    ).toBeVisible();
    const mutations = await page.evaluate(() =>
        window.__E2E_TAURI__
            .invocations()
            .filter((call) =>
                ["write_workspace_file_metadata", "rename_workspace_file"].includes(call.command),
            ),
    );
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toEqual({
        command: "write_workspace_file_metadata",
        args: {
            workspace: filesWorkspaceFixture.workspace,
            entry: initial.handle,
            metadata: edited.metadata,
        },
    });
});

test("database-files: Move destination wraps at 320px and 200% and submits the selected handle", async ({
    page,
    mockScenario,
}) => {
    await page.setViewportSize({ width: 320, height: 900 });
    const destination = {
        ...openingDirectory,
        name: "OneUnbrokenDirectoryNameThatIsMuchWiderThanTheMoveDialogAtTwoHundredPercent",
    };
    await mockScenario({
        commands: filesWorkspaceCommands([[pgnFile, destination], [destination]], {
            ...pgnFileCommands,
            move_workspace_entry: { result: null },
        }),
    });
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    await selectFilesTreeRow(page, pgnFile.name);
    await page
        .getByRole("treeitem", { name: pgnFile.name, exact: true })
        .getByRole("button", { name: "Move", exact: true })
        .click();
    const dialog = page.getByRole("dialog", { name: "Move file", exact: true });
    await expect(dialog.getByRole("radio", { name: "Collection root", exact: true })).toBeChecked();
    await expect(dialog.getByText("Collection root", { exact: true })).toBeVisible();
    await assertNothingClipped(dialog);
    const radio = dialog.getByRole("radio", { name: destination.name, exact: true });
    await radio.check();
    await expect(radio).toBeChecked();
    const label = dialog.getByText(destination.name, { exact: true });
    await expect(label).toBeVisible();
    await assertNothingClipped(dialog);
    await assertNothingClipped(label, { mode: "reachable" });
    const wrapping = await label.evaluate((element) => {
        const offenders = [];
        const dialog = element.closest('[role="dialog"]');
        for (let node: Element | null = element; node; node = node.parentElement) {
            if (
                getComputedStyle(node).textOverflow === "ellipsis" &&
                node.scrollWidth > node.clientWidth + 1
            ) {
                offenders.push({
                    tag: node.tagName,
                    className: node.className,
                    scrollWidth: node.scrollWidth,
                    clientWidth: node.clientWidth,
                });
            }
            if (node === dialog) break;
        }
        return { offenders, overflowWrap: getComputedStyle(element).overflowWrap };
    });
    expect(wrapping.offenders).toEqual([]);
    expect(wrapping.overflowWrap).toBe("anywhere");
    await dialog.getByRole("button", { name: "Move", exact: true }).click();
    await expect(dialog).toBeHidden();
    const moves = await page.evaluate(() =>
        window.__E2E_TAURI__
            .invocations()
            .filter((call) => call.command === "move_workspace_entry"),
    );
    expect(moves).toHaveLength(1);
    expect(moves[0].args).toEqual({
        workspace: filesWorkspaceFixture.workspace,
        entry: pgnFile.handle,
        targetDirectory: destination.handle,
    });
});

test("database-files: grants a workspace and creates a folder through typed IPC", async ({
    page,
    mockScenario,
    assertAccessible,
    assertNoHorizontalOverflow,
    capture,
}) => {
    await mockScenario({
        commands: filesWorkspaceCommands([[pgnFile], [openingDirectory, pgnFile]], {
            ...pgnFileCommands,
            create_workspace_directory: { result: openingDirectory },
        }),
    });
    await page.goto("/library");

    await page.getByRole("button", { name: /choose folder/i }).click();
    await expect(page.getByRole("button", { name: /create folder/i })).toBeVisible();
    await expect(page.getByText("Openings")).toHaveCount(0);
    await page.getByRole("button", { name: /create folder/i }).click();
    const dialog = page.getByRole("dialog", { name: /create folder/i });
    await expect(dialog.getByLabel(/name/i)).toBeFocused();
    await dialog.getByLabel(/name/i).fill("Openings");
    await dialog.getByRole("button", { name: /confirm/i }).click();
    await expect(page.locator('[data-modal-content="true"]')).toHaveCount(0);

    await expect(page.getByText("Openings")).toBeVisible();
    await selectFilesTreeRow(page, pgnFile.name);
    await expect(page.getByRole("button", { name: "Open game", exact: true })).toBeVisible();
    await expect(page.getByText("Weiss - Schwarz")).toBeVisible();
    await assertNoHorizontalOverflow();
    await assertFilesColumnsNotClipped(page);
    await assertAccessible();
    await capture("database-files");
    await expect(page).toHaveScreenshot("database-files.png", { fullPage: true });
});

const databaseKey = "navigation-db";
const databaseTitle = "Navigation database";
const databaseScenario: MockScenario = {
    commands: {
        ...databaseCommands(databaseKey, "navigation.db3", {
            title: databaseTitle,
            description: "",
            player_count: 0,
            event_count: 0,
            game_count: 0,
            storage_size: "0",
            indexed: false,
        }),
        get_games: { result: { data: [], count: 0 } },
        get_players: { result: { data: [], count: 0 } },
        get_tournaments: { result: { data: [], count: 0 } },
    },
};

test("database-files: a new local import closes the add dialog and shows its live progress", async ({
    page,
    mockScenario,
    emitTauriEvent,
}) => {
    await mockScenario({
        commands: {
            ...databaseScenario.commands,
            issue_pgn_workspace: {
                result: {
                    handle: { id: { id: "mega-pgn" }, kind: "fileWorkspace" },
                    displayName: "mega.pgn",
                    availability: "available",
                },
            },
            create_workspace_database: { result: { id: { id: "mega-db" }, kind: "database" } },
            count_pgn_games: { result: 100 },
            convert_pgn: { delay: 60_000, result: null },
        },
    });
    await page.goto("/library");
    await page.getByRole("button", { name: "Import or download database", exact: true }).click();
    const add = page.getByRole("dialog");
    await add.getByRole("tab", { name: "Local", exact: true }).click();
    await add.getByRole("button", { name: "PGN file", exact: true }).click();
    await add.getByRole("button", { name: "Convert", exact: true }).click();
    // The import runs for minutes; the dialog must not cover its progress row meanwhile.
    await expect(add).toHaveCount(0);
    // The closed dialog cannot be reopened to submit the same file a second time.
    await expect(
        page.getByRole("button", { name: "Import or download database", exact: true }),
    ).toBeDisabled();
    await expect
        .poll(() =>
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
            imported_games: 120,
            elapsed_ms: 2000,
            source_file_name: "mega.pgn",
        },
    });
    const row = page.getByText("Convert: mega.pgn", { exact: true }).locator("../..");
    await expect(row).toHaveText("Convert: mega.pgn120 games • 60.0 games/sCancel");
    await expect(row.getByRole("button", { name: "Cancel: mega.pgn", exact: true })).toBeVisible();
});

test("database-files: concurrent conversions render their own live progress counters", async ({
    page,
    mockScenario,
    emitTauriEvent,
    capture,
    assertAccessible,
    assertNoHorizontalOverflow,
}) => {
    // Deliver the real lazy Board module slowly so an immediate return can cancel navigation.
    await page.route(/\/assets\/index\.lazy-[^/]+\.js$/, async (route) => {
        const response = await route.fetch();
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await route.fulfill({ response });
    });
    await mockScenario({
        commands: {
            ...databaseScenario.commands,
            issue_pgn_workspace: {
                results: [
                    {
                        handle: { id: { id: "first-pgn" }, kind: "fileWorkspace" },
                        displayName: "first.pgn",
                        availability: "available",
                    },
                    {
                        handle: { id: { id: "second-pgn" }, kind: "fileWorkspace" },
                        displayName: "second.pgn",
                        availability: "available",
                    },
                ],
            },
            count_pgn_games: { result: 100 },
            convert_pgn: { delay: 60_000, result: null },
            cancel_conversion: { delay: 60_000, result: true },
        },
    });
    await page.goto("/library");
    await page.getByRole("button").filter({ hasText: databaseTitle }).click();
    const addGames = page.getByRole("button", { name: /^add games$/i });
    // Admit both native pickers before conversion makes the selected target unavailable.
    await addGames.evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
    });
    await expect(page.getByText("Convert: first", { exact: true })).toBeVisible();
    await expect(addGames).toHaveCount(0);
    await expect(page.getByText("Convert: second", { exact: true })).toBeVisible();

    const ids = await page.evaluate(() =>
        window.__E2E_TAURI__
            .invocations()
            .filter((call) => call.command === "convert_pgn")
            .map((call) => (call.args as { progressId: string }).progressId),
    );
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^conversion:[0-9a-f-]{36}$/);
    expect(ids[1]).toMatch(/^conversion:[0-9a-f-]{36}$/);
    expect(ids[0]).not.toBe(ids[1]);
    await emitTauriEvent({
        event: "convert-progress",
        payload: {
            id: ids[0],
            imported_games: 120,
            elapsed_ms: 2000,
            source_file_name: "first.pgn",
        },
    });
    await emitTauriEvent({
        event: "convert-progress",
        payload: {
            id: ids[1],
            imported_games: 42,
            elapsed_ms: 3000,
            source_file_name: "second.pgn",
        },
    });
    const firstRow = page.getByText("Convert: first.pgn", { exact: true }).locator("../..");
    const secondRow = page.getByText("Convert: second.pgn", { exact: true }).locator("../..");
    await expect(firstRow).toHaveText("Convert: first.pgn120 games • 60.0 games/sCancel");
    await expect(secondRow).toHaveText("Convert: second.pgn42 games • 14.0 games/sCancel");
    // Client navigation preserves the fixture session and the app-owned conversion registry.
    await goToBoards(page);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("tab", { name: "New Tab", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Library", exact: true }).click();
    await expect(page).toHaveURL("/library");
    await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
    await expect(
        page.getByText(
            "This database is being converted. Its actions will return when conversion finishes.",
            { exact: true },
        ),
    ).toBeVisible();
    await expect(firstRow).toHaveText("Convert: first.pgn120 games • 60.0 games/sCancel");
    await expect(secondRow).toHaveText("Convert: second.pgn42 games • 14.0 games/sCancel");
    const cancel = firstRow.getByRole("button", { name: "Cancel: first.pgn", exact: true });
    let previousRowTop: number | undefined;
    for (const edge of ["end", "start"] as const) {
        // Both prior alignments must converge on the same canonical capture position.
        await secondRow.evaluate(
            (node, block) => node.scrollIntoView({ block, behavior: "instant" }),
            edge,
        );
        const rowTop = await secondRow.evaluate((node) => node.getBoundingClientRect().top);
        if (previousRowTop !== undefined) expect(rowTop).not.toBe(previousRowTop);
        previousRowTop = rowTop;
        await secondRow.evaluate((node) =>
            node.scrollIntoView({ block: "center", behavior: "instant" }),
        );
        await expect(secondRow).toBeInViewport();
        await expect(cancel).toBeInViewport({ ratio: 1 });
        await expect(
            secondRow.getByRole("button", { name: "Cancel: second.pgn", exact: true }),
        ).toBeInViewport({ ratio: 1 });
        await page.mouse.move(400, 40);
        await expect(page.getByRole("tooltip")).toHaveCount(0);
        await assertNoHorizontalOverflow();
        await assertAccessible();
        await capture("conversion-active");
        await expect(page).toHaveScreenshot("conversion-active.png", { fullPage: true });
    }
    await cancel.click();
    await expect(cancel).toBeDisabled();
    await expect(
        secondRow.getByRole("button", { name: "Cancel: second.pgn", exact: true }),
    ).toBeEnabled();
    const calls = await page.evaluate(() => window.__E2E_TAURI__.invocations());
    const converted = calls.filter((call) => call.command === "convert_pgn");
    expect(
        (calls.find((call) => call.command === "cancel_conversion")!.args as { ticket: string })
            .ticket,
    ).toBe((converted[0].args as { ticket: string }).ticket);
    expect((converted[0].args as { ticket: string }).ticket).not.toBe(
        (converted[1].args as { ticket: string }).ticket,
    );
    await capture("conversion-cancel-pending");
    await expect(page).toHaveScreenshot("conversion-cancel-pending.png", { fullPage: true });
    await expect(
        page.getByRole("button", { name: "Import or download database", exact: true }),
    ).toBeDisabled();
});

test("database-files: admission conflicts show temporary-use recovery while ordinary failures keep corruption guidance", async ({
    page,
    mockScenario,
}) => {
    const conflict = {
        tag: "backend-error",
        category: "conflict",
        message: "Conflict: database is open through another name",
    };
    await mockScenario({
        commands: {
            ...databaseScenario.commands,
            list_workspace_databases: {
                result: {
                    entries: ["admission", "ordinary"].map((id) => ({
                        handle: { id: { id }, kind: "database" },
                        filename: `${id}.db3`,
                        availability: "available",
                    })),
                    unread: [],
                },
            },
            get_db_info: {
                outcomes: [
                    { error: { ...conflict, databaseAdmission: true } },
                    { error: conflict },
                ],
            },
        },
    });
    await page.goto("/library");
    const detail = page.locator(".mantine-Paper-root").filter({
        has: page.getByRole("button", { name: "Delete", exact: true }),
    });
    const admission = "This database is already open under another name";
    const recovery = "It can be opened again after that use ends.";
    const generic = "There was an error loading this database";
    const corruption = "Check if the file exists and that it is not corrupted.";

    await page.getByRole("button").filter({ hasText: "admission.db3" }).click();
    await expect(detail.getByText(admission, { exact: true })).toBeVisible();
    await expect(detail.getByText(recovery, { exact: true })).toBeVisible();
    await expect(detail.getByText(generic, { exact: true })).toHaveCount(0);
    await expect(detail.getByText("Reason:", { exact: true })).toHaveCount(0);
    await expect(detail.getByText(corruption, { exact: true })).toHaveCount(0);
    await assertNothingClipped(detail);

    await page.getByRole("button").filter({ hasText: "ordinary.db3" }).click();
    await expect(detail.getByText(generic, { exact: true })).toBeVisible();
    await expect(detail.getByText(corruption, { exact: true })).toBeVisible();
    await expect(detail.getByText(admission, { exact: true })).toHaveCount(0);
    await expect(detail.getByText(recovery, { exact: true })).toHaveCount(0);
    await assertNothingClipped(detail);
});

test("database-files: an unfinished import stays visible with Delete and no reference star", async ({
    page,
    mockScenario,
    assertAccessible,
    assertNoHorizontalOverflow,
    capture,
}) => {
    await mockScenario({
        commands: {
            ...databaseScenario.commands,
            get_db_info: {
                error: {
                    tag: "backend-error",
                    category: "invalid-input",
                    message: "Invalid input: Database has not been initialized yet",
                },
            },
        },
    });
    await page.goto("/library");
    const card = page
        .getByRole("button")
        .filter({ hasText: "Import did not finish — delete it and import again" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("navigation.db3");
    await expect(card.locator(".mantine-Rating-root")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open database", exact: true })).toHaveCount(0);
    await card.dblclick();
    await expect(page).toHaveURL("/library");
    await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Explore", exact: true })).toHaveCount(0);
    await assertNoHorizontalOverflow();
    await assertAccessible();
    await capture("database-unfinished-import");
    await expect(page).toHaveScreenshot("database-unfinished-import.png", { fullPage: true });
});

test("database-files: Back opens the overview and ends the active database session", async ({
    page,
    mockScenario,
}) => {
    await mockScenario(databaseScenario);
    await page.goto("/library");
    await page.getByRole("button").filter({ hasText: databaseTitle }).dblclick();
    await expect(page).toHaveURL(`/databases/${databaseKey}`);
    await expect(page.getByRole("heading", { name: databaseTitle, exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page).toHaveURL("/library");
    await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: databaseTitle, exact: true })).toBeHidden();

    await goToBoards(page);
    await expect(page).toHaveURL(/\/$/);
    await goToLibrary(page);
    await expect(page).toHaveURL("/library");
    await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
});

test("database-files: the sidebar resumes the active database view", async ({
    page,
    mockScenario,
}) => {
    await mockScenario(databaseScenario);
    await page.goto("/library");
    await page.getByRole("button").filter({ hasText: databaseTitle }).click();
    await page.getByRole("link", { name: "Explore", exact: true }).click();
    await expect(page).toHaveURL(`/databases/${databaseKey}`);
    await expect(page.getByRole("heading", { name: databaseTitle, exact: true })).toBeVisible();

    await goToBoards(page);
    await expect(page).toHaveURL(/\/$/);
    const databasesLink = libraryLink(page);
    await expect(databasesLink).not.toHaveAttribute("aria-current", "page");
    await databasesLink.click();
    await expect(page).toHaveURL(`/databases/${databaseKey}`);
    await expect(page.getByRole("heading", { name: databaseTitle, exact: true })).toBeVisible();
    await expect(databasesLink).toHaveAttribute("aria-current", "page");
});

for (const appearance of [
    { name: "dark", colorScheme: "dark", variant: null },
    { name: "light", colorScheme: "light", variant: null },
    { name: "dim", colorScheme: "dark", variant: "dim" },
] as const) {
    test(`database-files: the current records-per-page size stays legible in ${appearance.name} mode`, async ({
        page,
        mockScenario,
    }) => {
        await page.addInitScript(({ colorScheme, variant }) => {
            localStorage.setItem("mantine-color-scheme", colorScheme);
            if (variant) localStorage.setItem("theme-variant", JSON.stringify(variant));
        }, appearance);
        await page.setViewportSize({ width: 1440, height: 900 });
        await mockScenario({ commands: databaseLayoutCommands });
        await page.goto(`/databases/${gameOpeningFixture.databaseId}`);
        await expect(page.locator("html")).toHaveAttribute(
            "data-mantine-color-scheme",
            appearance.colorScheme,
        );
        if (appearance.variant === "dim") {
            await expect(page.locator("html")).toHaveAttribute("data-cf-theme-variant", "dim");
        }
        await page.getByRole("tab", { name: "Events", exact: true }).click();
        const events = page.getByRole("tabpanel", { name: "Events", exact: true });
        await events.getByRole("button", { name: "25", exact: true }).click();
        const current = page.getByRole("menuitem", { name: "25", exact: true });
        await expect(current).toBeVisible();

        const metrics = await paintedText(current);
        expect(metrics.opacity, "the current size is not drawn as unavailable").toBe(1);
        expect(
            contrastRatio(metrics.color, metrics.layers),
            "current page size contrast",
        ).toBeGreaterThanOrEqual(4.5);
        await expect(page.locator(".mantine-Menu-dropdown")).toHaveScreenshot(
            `records-per-page-menu-${appearance.name}.png`,
        );
    });
}

async function installAllModeGamesMock(
    page: Page,
    options: {
        count: number;
        prefix: string;
        event: string;
        moves: string;
        distinctPlies?: boolean;
        emptyOnBlackWin?: boolean;
        handleGetDbGame?: boolean;
    },
) {
    await page.addInitScript((opts) => {
        type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
        const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } })
            .__TAURI_INTERNALS__;
        const invoke = internals.invoke;
        const allGames = Array.from({ length: opts.count }, (_, index) => {
            const id = index + 1;
            return {
                id,
                stamp: String(id).padStart(64, "a"),
                white: `${opts.prefix} White ${id}`,
                white_id: id,
                white_elo: 2500,
                black: `${opts.prefix} Black ${id}`,
                black_id: id + 1000,
                black_elo: 2450,
                date: "2026.01.01",
                result: "1-0",
                ply_count: opts.distinctPlies ? id * 2 : 40,
                event: opts.event,
                event_id: 1,
                site: "Berlin",
                site_id: 1,
                fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
                moves: opts.moves,
            };
        });
        internals.invoke = async (command, args = {}) => {
            if (command === "get_games") {
                const query = args.query as {
                    outcome?: string | null;
                    options?: {
                        page?: number;
                        pageSize?: number;
                        skipCount?: boolean;
                        sort?: string;
                        direction?: "asc" | "desc";
                    };
                };
                if (opts.emptyOnBlackWin && query?.outcome === "0-1") {
                    return { data: [], count: 0 };
                }
                const ordered = [...allGames];
                if (query?.options?.sort === "plyCount") {
                    ordered.sort((a, b) =>
                        query.options?.direction === "desc"
                            ? b.ply_count - a.ply_count
                            : a.ply_count - b.ply_count,
                    );
                }
                const page = query?.options?.page ?? 1;
                const pageSize = query?.options?.pageSize ?? 25;
                const start = (page - 1) * pageSize;
                return {
                    data: ordered.slice(start, start + pageSize),
                    count: query?.options?.skipCount ? null : ordered.length,
                };
            }
            if (opts.handleGetDbGame && command === "get_db_game") {
                const game = allGames.find((row) => row.id === args.gameId);
                return game ? { kind: "found", game } : { kind: "missing" };
            }
            return invoke(command, args);
        };
    }, options);
}

test("database-files: games list All mode loads chunks on scroll, keeps footer with zero rows, and switches back to page 1", async ({
    page,
    mockScenario,
}) => {
    await page.addInitScript(() => {
        localStorage.setItem("font-size", "100");
        localStorage.setItem("mantine-color-scheme", "dark");
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockScenario({ commands: databaseLayoutCommands });
    await installAllModeGamesMock(page, {
        count: 150,
        prefix: "Scroll",
        event: "Scroll Cup",
        moves: "1. e4 e5 1-0",
        emptyOnBlackWin: true,
    });

    await page.goto(`/databases/${gameOpeningFixture.databaseId}`);
    const gamesPanel = page.getByRole("tabpanel", { name: "Games", exact: true });
    const tablePane = gamesPanel.locator('[data-database-pane="table"]');
    const footer = tablePane.locator("[data-database-list-footer]");

    await expect(tablePane.locator("tbody tr")).toHaveCount(25);
    await expect(footer).toContainText("1 - 25 / 150");

    // Switch to "All": first 100-row chunk loads, DOM stays windowed below the loaded count.
    await footer.getByRole("button", { name: "25", exact: true }).click();
    await page.getByRole("menuitem", { name: "All", exact: true }).click();
    await expect(footer).toContainText("Showing 100 of 150");
    const firstChunkRows = await tablePane.locator("tbody tr").count();
    expect(firstChunkRows).toBeGreaterThan(0);
    expect(firstChunkRows).toBeLessThan(100);

    await waitForFontsSettled(page);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.mouse.move(0, 0);
    await expect(tablePane).toHaveScreenshot("games-list-all-mode.png", {
        stylePath: scrollbarFreeScreenshot,
    });

    // Scroll the table viewport to the bottom: second chunk loads (150 total) while DOM stays windowed.
    const viewport = tablePane.locator(".mantine-ScrollArea-viewport").first();
    await viewport.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
    });
    await expect(footer).toContainText("Showing 150 of 150");
    const secondChunkRows = await tablePane.locator("tbody tr").count();
    expect(secondChunkRows).toBeGreaterThan(0);
    expect(secondChunkRows).toBeLessThan(100);

    // Filter matching zero rows: footer stays mounted in All mode.
    await tablePane.getByRole("button", { name: "More options", exact: true }).click();
    await tablePane.getByRole("textbox", { name: "Result", exact: true }).click();
    await page.getByRole("option", { name: "Black wins", exact: true }).click();
    await expect(tablePane.getByText("No games found", { exact: true })).toBeVisible();
    await expect(footer).toBeVisible();
    await expect(footer).toContainText("Showing 0 of 0");
    await expect(footer.getByRole("button", { name: "All", exact: true })).toBeVisible();

    // Clear filter and switch back to 25 -> returns to page 1 with all 25 rows rendered.
    await tablePane.locator(".mantine-Select-root button").first().click();
    await expect(footer).toContainText("Showing 100 of 150");
    await footer.getByRole("button", { name: "All", exact: true }).click();
    await page.getByRole("menuitem", { name: "25", exact: true }).click();
    await expect(tablePane.locator("tbody tr")).toHaveCount(25);
    await expect(footer).toContainText("1 - 25 / 150");
    await expect(tablePane.locator("tbody tr").first()).toContainText("Scroll White 1");
});

test("database-files: windowed All mode bounds DOM across chunks, keeps ArrowDown selection visible, opens scrolled rows via Enter and double-click, and resets scroll on sort", async ({
    page,
    mockScenario,
}) => {
    await page.addInitScript(() => {
        localStorage.setItem("font-size", "100");
        localStorage.setItem("mantine-color-scheme", "dark");
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockScenario({
        commands: filesWorkspaceCommands([[]], {
            ...databaseLayoutCommands,
            infer_game_orientation: { result: null },
        }),
    });
    await installAllModeGamesMock(page, {
        count: 250,
        prefix: "Window",
        event: "Window Cup",
        moves: gameOpeningFixture.games[0].moves,
        distinctPlies: true,
        handleGetDbGame: true,
    });

    await page.goto(`/databases/${gameOpeningFixture.databaseId}`);
    const gamesPanel = page.getByRole("tabpanel", { name: "Games", exact: true });
    const tablePane = gamesPanel.locator('[data-database-pane="table"]');
    const footer = tablePane.locator("[data-database-list-footer]");
    const viewport = tablePane.locator(".mantine-ScrollArea-viewport").first();

    // Paged mode renders all 25 rows.
    await expect(tablePane.locator("tbody tr")).toHaveCount(25);

    // Switch to "All" and scroll to the bottom twice to load 3 chunks (250 rows).
    await footer.getByRole("button", { name: "25", exact: true }).click();
    await page.getByRole("menuitem", { name: "All", exact: true }).click();
    await expect(footer).toContainText("Showing 100 of 250");

    await viewport.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
    });
    await expect(footer).toContainText("Showing 200 of 250");

    await viewport.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
    });
    await expect(footer).toContainText("Showing 250 of 250");

    // Rendered tbody tr stays far below the 250 loaded rows.
    const renderedRows = await tablePane.locator("tbody tr").count();
    expect(renderedRows).toBeGreaterThan(0);
    expect(renderedRows).toBeLessThan(100);

    // ArrowDown past the visible viewport scrolls the selected row into view.
    await viewport.evaluate((node) => {
        node.scrollTop = 0;
    });
    const firstRow = tablePane.locator("tbody tr").filter({ hasText: "Window White 1" }).first();
    await firstRow.click();
    for (let i = 0; i < 30; i++) {
        await page.keyboard.press("ArrowDown");
    }
    const selectedRow = tablePane.locator('tbody tr[aria-selected="true"]');
    await expect(selectedRow).toContainText("Window White 31");
    const readSelectedVisibility = () =>
        selectedRow.evaluate((row) => {
            const vp = row.closest<HTMLElement>(".mantine-ScrollArea-viewport")!;
            const thead = vp.querySelector("thead")!;
            const rowRect = row.getBoundingClientRect();
            const vpRect = vp.getBoundingClientRect();
            const headRect = thead.getBoundingClientRect();
            return {
                scrollTop: vp.scrollTop,
                topOk: rowRect.top >= headRect.bottom - 1,
                bottomOk: rowRect.bottom <= vpRect.bottom + 1,
            };
        });
    const visibility = await readSelectedVisibility();
    expect(visibility.scrollTop).toBeGreaterThan(0);
    expect(visibility.topOk).toBe(true);
    expect(visibility.bottomOk).toBe(true);

    // ArrowUp past the top of the visible window scrolls up and keeps the selected row below thead.
    for (let i = 0; i < 20; i++) {
        await page.keyboard.press("ArrowUp");
    }
    await expect(selectedRow).toContainText("Window White 11");
    const visibilityAfterUp = await readSelectedVisibility();
    expect(visibilityAfterUp.scrollTop).toBeLessThan(visibility.scrollTop);
    expect(visibilityAfterUp.topOk).toBe(true);
    expect(visibilityAfterUp.bottomOk).toBe(true);

    // Scroll to a deep row (160) and open it with Enter.
    await viewport.evaluate((node) => {
        node.scrollTop = Math.floor(node.scrollHeight * 0.62);
    });
    const enterTarget = tablePane
        .locator("tbody tr")
        .filter({ hasText: "Window White 160" })
        .first();
    await expect(enterTarget).toBeVisible();
    await enterTarget.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL("/");
    const tabAfterEnter = await activeWorkspaceTab(page);
    expect(tabAfterEnter.name).toBe("Window White 160 - Window Black 160");

    // Return to the database, scroll down to another row (180), and open it with double-click.
    // Extra All-mode chunks survive when the Games list stays mounted and reset to the
    // first chunk when it remounts. Load until row 180 exists instead of assuming a reset.
    await page.locator("nav").getByRole("link", { name: "Library", exact: true }).click();
    await expect(page).toHaveURL(`/databases/${gameOpeningFixture.databaseId}`);
    await expect(footer).toContainText(/Showing \d+ of 250/);
    const dblClickTarget = tablePane
        .locator("tbody tr")
        .filter({ hasText: "Window White 180" })
        .first();
    await expect
        .poll(
            async () => {
                const text = await footer.innerText();
                const match = text.match(/Showing (\d+) of 250/);
                const shown = match ? Number(match[1]) : 0;
                if (shown < 180) {
                    await viewport.evaluate((node) => {
                        node.scrollTop = node.scrollHeight;
                    });
                    return 0;
                }
                await viewport.evaluate((node, ratio) => {
                    node.scrollTop = Math.floor(node.scrollHeight * ratio);
                }, 179 / shown);
                return dblClickTarget.count();
            },
            { timeout: 15_000 },
        )
        .toBeGreaterThan(0);
    await expect(dblClickTarget).toBeVisible();
    await dblClickTarget.dblclick();
    await expect(page).toHaveURL("/");
    const tabAfterDblClick = await activeWorkspaceTab(page);
    expect(tabAfterDblClick.name).toBe("Window White 180 - Window Black 180");

    // Return, scroll down, then sort by Plies: restarts at top (scrollTop = 0) with the new order.
    await page.locator("nav").getByRole("link", { name: "Library", exact: true }).click();
    await expect(page).toHaveURL(`/databases/${gameOpeningFixture.databaseId}`);
    await expect(footer).toContainText(/Showing \d+ of 250/);
    await viewport.evaluate((node) => {
        node.scrollTop = 1000;
    });
    await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    await tablePane
        .locator("thead")
        .getByRole("button", { name: /^Plies(\s|$)/ })
        .click();
    await expect(tablePane.locator("tbody tr").first()).toContainText("Window White 250");
    await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBe(0);
});

const lichessExplorerPosition = {
    white: 80,
    black: 50,
    draws: 70,
    moves: [
        { uci: "e2e4", san: "e4", averageRating: 2200, white: 50, black: 20, draws: 30 },
        { uci: "d2d4", san: "d4", averageRating: 2100, white: 20, black: 10, draws: 10 },
    ],
};

const lichessExplorerSession = serializeStorageValue([
    {
        updatedAt: Date.UTC(2024, 0, 1),
        lichess: {
            username: "explorer-player",
            account: { id: "explorer-player", username: "explorer-player" },
        },
    },
]);

const lichessExplorerCommands: NonNullable<MockScenario["commands"]> = {
    list_lichess_accounts: {
        result: [{ handle: "explorer-account", username: "explorer-player" }],
    },
    get_authenticated_lichess_explorer: {
        result: JSON.stringify(lichessExplorerPosition),
    },
};

/**
 * An analysis board over the fixture Mega database, optionally with a second local database and a
 * signed-in Lichess account. `stored` seeds further `localStorage` values before the first load.
 */
async function openBoardOverDatabases(
    page: Page,
    mockScenario: MockScenario,
    options: {
        comparison?: boolean;
        signedIn?: boolean;
        stored?: Record<string, string>;
    } = {},
) {
    const mega = { id: { id: gameOpeningFixture.databaseId }, kind: "database" as const };
    const corr = { id: { id: "correspondence-db" }, kind: "database" as const };
    const comparison = options.comparison === true;
    const signedIn = options.signedIn === true;
    const stored = options.stored ?? {};
    await page.addInitScript(
        ({ mega, corr, comparison, sessions, stored }) => {
            localStorage.setItem("reference-database", JSON.stringify(mega));
            if (comparison) {
                localStorage.setItem("comparison-database", JSON.stringify(corr));
                localStorage.setItem(
                    "explorer-database-filters",
                    JSON.stringify([
                        {
                            database: mega.id.id,
                            filters: {
                                player: null,
                                color: "white",
                                result: "any",
                                elo: [1900, 2500],
                            },
                        },
                    ]),
                );
            }
            localStorage.setItem("font-size", "100");
            if (sessions) localStorage.setItem("sessions", sessions);
            for (const [key, value] of Object.entries(stored)) localStorage.setItem(key, value);
        },
        {
            mega,
            corr,
            comparison,
            sessions: signedIn ? lichessExplorerSession : null,
            stored,
        },
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await mockScenario({
        commands: filesWorkspaceCommands([[]], {
            ...gameOpeningCommands,
            list_workspace_databases: {
                result: {
                    entries: [
                        { handle: mega, filename: "mega.db3", availability: "available" },
                        ...(comparison
                            ? [{ handle: corr, filename: "corr.db3", availability: "available" }]
                            : []),
                    ],
                    unread: [],
                },
            },
            get_progress: { result: null },
            linked_collections_supported: { result: true },
            list_linked_collections: { result: [] },
            search_position: { result: [[], []] },
            ...(signedIn ? lichessExplorerCommands : {}),
        }),
    });
    // The shared mock answers by command alone; these two commands differ by database here.
    await page.addInitScript(
        ({ megaId, comparison }) => {
            type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
            const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } })
                .__TAURI_INTERNALS__;
            const invoke = internals.invoke;
            const row = (move: string, white: number, draw: number, black: number) => ({
                move,
                white,
                draw,
                black,
                unknown: 0,
                last_played: null,
                year_counts: [],
                recent: [],
            });
            internals.invoke = async (command, args = {}) => {
                const reply = await invoke(command, args);
                const file = (args.file as { id?: { id?: string } } | undefined)?.id?.id;
                if (!file) return reply;
                const isMega = file === megaId;
                if (command === "get_db_info") {
                    return {
                        ...(reply as object),
                        title: isMega ? "Mega Database" : "Correspondence",
                    };
                }
                if (command === "search_position") {
                    if (isMega) {
                        return [
                            [
                                row("e4", 500, 300, 400),
                                row("d4", 300, 200, 150),
                                row("c4", 40, 30, 20),
                            ],
                            [],
                        ];
                    }
                    if (comparison) {
                        return [
                            [row("d4", 20, 90, 10), row("h4", 10, 60, 5), row("e4", 5, 25, 5)],
                            [],
                        ];
                    }
                }
                return reply;
            };
        },
        { megaId: mega.id.id, comparison },
    );
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    await expect(
        page.getByRole("button", { name: "Open database", exact: true }).first(),
    ).toBeVisible();
    await goToBoards(page);
    await page.getByRole("button", { name: /^Analysis Board$/ }).click();
    return { mega, corr };
}

async function openBoardOverTwoDatabases(
    page: Page,
    mockScenario: MockScenario,
    stored: Record<string, string> = {},
) {
    return openBoardOverDatabases(page, mockScenario, { comparison: true, stored });
}

async function openBoardOverMegaDatabase(
    page: Page,
    mockScenario: MockScenario,
    signedIn: boolean,
) {
    const { mega } = await openBoardOverDatabases(page, mockScenario, { signedIn });
    return mega;
}

async function expectExplorerSourcesAligned(page: Page, columns: number) {
    const edges = await page.evaluate(() => {
        const left = (element: Element) => Math.round(element.getBoundingClientRect().left);
        return {
            cells: [...document.querySelectorAll("[data-explorer-source]")].map(left),
            headers: [...document.querySelectorAll("thead th")]
                .filter((th) => (th as HTMLElement).offsetParent !== null)
                .map(left),
        };
    });
    for (let index = 0; index < columns; index++) {
        expect(Math.abs(edges.cells[index]! - edges.headers[1 + index * 3]!)).toBeLessThanOrEqual(
            2,
        );
    }
}

test("database-files: the board explorer compares two databases side by side", async ({
    page,
    mockScenario,
}) => {
    const { mega, corr } = await openBoardOverTwoDatabases(page, mockScenario);
    await page.getByRole("tab", { name: "Database", exact: true }).click();

    // Collapsed by default: one caption per database, naming its active filters, each above
    // its column group; settings and Hide games sit on the chrome row.
    const sources = page.locator("[data-explorer-source]");
    const databasePanel = page.getByRole("tabpanel", { name: "Database", exact: true });
    await expect(sources).toHaveCount(2);
    // The filters sit on their own line under the database name.
    await expect(sources.nth(0).locator(":scope > :first-child")).toHaveText("Mega Database");
    await expect(sources.nth(0).locator("[data-explorer-source-detail]")).toHaveText(
        "Elo 1900–2500",
    );
    await expect(sources.nth(1)).toHaveText("Correspondence");
    await expect(sources.nth(1).locator("[data-explorer-source-detail]")).toHaveCount(0);
    const stats = databasePanel.getByRole("region", { name: "Stats", exact: true });
    await expect(databasePanel.getByRole("textbox")).toHaveCount(0);
    await expect(databasePanel.getByRole("tab")).toHaveCount(0);
    await expect(stats.locator("tbody tr")).toHaveCount(5);
    const expectSourcesAligned = async () => {
        const edges = await page.evaluate(() => {
            const left = (element: Element) => Math.round(element.getBoundingClientRect().left);
            return {
                cells: [...document.querySelectorAll("[data-explorer-source]")].map(left),
                headers: [...document.querySelectorAll("thead th")]
                    .filter((th) => (th as HTMLElement).offsetParent !== null)
                    .map(left),
            };
        });
        expect(Math.abs(edges.cells[0] - edges.headers[1])).toBeLessThanOrEqual(2);
        expect(Math.abs(edges.cells[1] - edges.headers[4])).toBeLessThanOrEqual(2);
    };
    await expectSourcesAligned();
    await expect(databasePanel).toHaveScreenshot("explorer-two-databases-collapsed.png");

    await page.getByRole("button", { name: "Show database settings", exact: true }).click();
    // Take the pointer off the button, so its tooltip is in no later image.
    await page.mouse.move(0, 0);

    // Each database has its own cell in the sources bar, with its own saved filters.
    await expect(sources).toHaveCount(2);
    await expect(sources.nth(0).getByRole("textbox")).toHaveValue("Mega Database");
    await expect(sources.nth(1).getByRole("textbox")).toHaveValue("Correspondence");
    await expect(
        sources.nth(0).getByRole("button", { name: "Filters: Elo 1900–2500", exact: true }),
    ).toBeVisible();
    const corrFilters = sources.nth(1).getByRole("button", { name: /^Filters: / });
    await expect(corrFilters).toHaveAccessibleName("Filters: No filter");
    await expect(page.getByRole("tab", { name: "Options", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Compare with a database" })).toHaveCount(0);

    // One table: the union of both databases' moves, ordered by the first one.
    const rows = stats.locator("tbody tr");
    const moves = () => rows.locator("td:first-child").allTextContents();
    await expect(rows).toHaveCount(5);
    expect(await moves()).toEqual(["e4", "d4", "c4", "h4", "Total"]);
    expect(await rows.nth(0).locator("td").allTextContents()).toEqual([
        "e4",
        "62%1,200",
        expect.stringMatching(/^\d+%$/),
        expect.any(String),
        "15%35",
        expect.stringMatching(/^\d+%$/),
        expect.any(String),
    ]);
    // A move one database never saw shows a dash on that side.
    expect(await rows.nth(2).locator("td").nth(4).textContent()).toBe("–");
    expect(await rows.nth(3).locator("td").nth(1).textContent()).toBe("–");
    await expect(stats.locator("[data-no-games]")).toHaveCount(2);
    expect(await rows.nth(4).locator("td").allTextContents()).toEqual([
        "Total",
        "1,940",
        expect.stringMatching(/^\d+%$/),
        expect.any(String),
        "230",
        expect.stringMatching(/^\d+%$/),
        expect.any(String),
    ]);

    // The cells of the sources bar stand above their column groups.
    await expectSourcesAligned();
    await expect(page.getByRole("tabpanel", { name: "Database", exact: true })).toHaveScreenshot(
        "explorer-two-databases.png",
    );

    // Sorting by the second database's Total reorders the same rows.
    await stats.locator("thead th").nth(4).click();
    await expect.poll(moves).toEqual(["d4", "h4", "e4", "c4", "Total"]);

    // A date picked in the comparison's filters keeps them open and is saved for it alone.
    await corrFilters.click();
    const filters = page.locator("[data-explorer-filters]");
    await filters.getByPlaceholder("Start date", { exact: true }).click();
    await page
        .locator("[data-dates-dropdown]")
        .getByRole("button", { name: /^15 / })
        .first()
        .click();
    await expect(filters).toBeVisible();
    await expect(corrFilters).toHaveAccessibleName(/^Filters: since /);
    const saved = await page.evaluate(
        () =>
            JSON.parse(localStorage.getItem("explorer-database-filters")!) as {
                database: string;
                filters: Record<string, unknown>;
            }[],
    );
    expect(saved.map((entry) => entry.database)).toEqual([mega.id.id, corr.id.id]);
    expect(saved[0].filters).toEqual({
        player: null,
        color: "white",
        result: "any",
        elo: [1900, 2500],
    });
    expect(saved[1].filters).toHaveProperty("start_date");
    await corrFilters.click();
    await expect(filters).toBeHidden();

    // The Games region below lists one database's sample games at a time.
    const games = databasePanel.getByRole("region", { name: "Games", exact: true });
    await expect(games.getByRole("radio", { name: "Mega Database", exact: true })).toBeChecked();
    await games.getByText("Correspondence", { exact: true }).click();
    await expect(games.getByRole("radio", { name: "Correspondence", exact: true })).toBeChecked();

    // Removing the comparison returns to the single-source table and offers to compare again.
    await page.getByRole("button", { name: "Remove comparison database", exact: true }).click();
    await expect(sources).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Compare with a database" })).toBeVisible();
    await expect(page.getByText(/Unexpected Tauri IPC command:/)).toHaveCount(0);
});

test("database-files: a local database sits beside Lichess All with Lichess totals and a dash", async ({
    page,
    mockScenario,
}) => {
    await openBoardOverMegaDatabase(page, mockScenario, true);
    await page.getByRole("tab", { name: "Database", exact: true }).click();
    await page.getByRole("button", { name: "Show database settings", exact: true }).click();
    await page.mouse.move(0, 0);
    await page.getByRole("button", { name: "Compare with a database" }).click();
    await expect(page.getByRole("menuitem")).toHaveText(["Lichess All", "Lichess Masters"]);
    await page.getByRole("menuitem", { name: "Lichess All", exact: true }).click();

    const sources = page.locator("[data-explorer-source]");
    await expect(sources).toHaveCount(2);
    await expect(sources.nth(0).getByRole("textbox")).toHaveValue("Mega Database");
    await expect(sources.nth(1).getByRole("textbox")).toHaveValue("Lichess All");
    await expect(page.getByRole("button", { name: /^Position: / })).toBeVisible();

    const stats = page.getByRole("region", { name: "Stats", exact: true });
    const rows = stats.locator("tbody tr");
    await expect(rows).toHaveCount(4);
    expect(await rows.locator("td:first-child").allTextContents()).toEqual([
        "e4",
        "d4",
        "c4",
        "Total",
    ]);
    expect(await rows.nth(2).locator("td").nth(4).textContent()).toBe("–");
    const totals = await rows.nth(3).locator("td").allTextContents();
    expect(totals[1]).toBe("1,940");
    expect(totals[4]).toBe("200");
    const listedLichess = lichessExplorerPosition.moves.reduce(
        (sum, move) => sum + move.white + move.black + move.draws,
        0,
    );
    expect(Number(totals[4]!.replaceAll(",", ""))).toBeGreaterThan(listedLichess);
    await expectExplorerSourcesAligned(page, 2);
    await waitForFontsSettled(page);
    await page.mouse.move(0, 0);
    await expect(page.getByRole("tabpanel", { name: "Database", exact: true })).toHaveScreenshot(
        "explorer-local-lichess.png",
    );
    await expect(page.getByText(/Unexpected Tauri IPC command:/)).toHaveCount(0);
});

test("database-files: Lichess All beside a local database without an account shows the sign-in notice", async ({
    page,
    mockScenario,
}) => {
    await openBoardOverMegaDatabase(page, mockScenario, false);
    await page.getByRole("tab", { name: "Database", exact: true }).click();
    await page.getByRole("button", { name: "Show database settings", exact: true }).click();
    await page.mouse.move(0, 0);
    await page.getByRole("button", { name: "Compare with a database" }).click();
    await page.getByRole("menuitem", { name: "Lichess All", exact: true }).click();

    const stats = page.getByRole("region", { name: "Stats", exact: true });
    await expect(stats.getByRole("alert")).toContainText(
        "Lichess Explorer now requires authentication",
    );
    const rows = stats.locator("tbody tr");
    await expect(rows).toHaveCount(4);
    expect(await rows.nth(3).locator("td").nth(1).textContent()).toBe("1,940");
    expect(await rows.nth(3).locator("td").nth(4).textContent()).toBe("");
    await expect(page.getByText(/Unexpected Tauri IPC command:/)).toHaveCount(0);
});

const opponentLinkId = "11111111-1111-4111-8111-111111111111";
const opponentDatabase = `opponent-${opponentLinkId}-0a1b2c3d.db3`;

/** The fixture database and, beside it, the downloaded online games of its player "First White". */
const opponentDatabaseCommands: NonNullable<MockScenario["commands"]> = {
    list_workspace_databases: {
        result: {
            entries: [
                {
                    handle: { id: { id: gameOpeningFixture.databaseId }, kind: "database" },
                    filename: "opening.db3",
                    availability: "available",
                },
                {
                    handle: { id: { id: "opponent-online-db" }, kind: "database" },
                    filename: opponentDatabase,
                    availability: "available",
                },
            ],
            unread: [],
        },
    },
    get_db_info: {
        ...databaseLayoutCommands.get_db_info,
        byDatabase: {
            "opponent-online-db": {
                status: "ready",
                filename: opponentDatabase,
                title: "First White (online)",
                description: "",
                game_count: 1234,
                player_count: 400,
                event_count: 3,
                storage_size: "8192",
                indexed: true,
            },
        },
    },
};
const opponentLink = {
    id: opponentLinkId,
    playerName: "First White",
    accounts: [
        { provider: "lichess", username: "FirstWhite" },
        { provider: "chesscom", username: "first_white" },
    ],
    filter: { years: 5, timeControls: ["blitz", "rapid"] },
    database: opponentDatabase,
};

/** Opens the fixture player's card in the Players tab and returns the pane holding it. */
async function openFirstWhiteCard(page: Page) {
    await page.goto(`/databases/${gameOpeningFixture.databaseId}`);
    await page.getByRole("tab", { name: "Players", exact: true }).click();
    const players = page.getByRole("tabpanel", { name: "Players", exact: true });
    await players
        .locator('[data-database-pane="table"] tbody tr')
        .filter({ hasText: "First White" })
        .click();
    return players.locator('[data-database-pane="preview"]');
}

for (const surface of [
    { width: 1440, scale: "100", scheme: "light" },
    { width: 320, scale: "200", scheme: "dark" },
] as const) {
    test(`database-files: an opponent's online account is looked up, confirmed and linked at ${surface.width}px`, async ({
        page,
        mockScenario,
        assertNoHorizontalOverflow,
    }) => {
        await page.addInitScript(({ scale, scheme }) => {
            localStorage.setItem("font-size", scale);
            localStorage.setItem("mantine-color-scheme", scheme);
        }, surface);
        await page.emulateMedia({ colorScheme: surface.scheme });
        await page.setViewportSize({ width: surface.width, height: 1000 });
        await page.clock.setFixedTime(new Date("2026-11-08T12:00:00Z"));
        await mockScenario({
            commands: {
                ...databaseLayoutCommands,
                get_public_lichess_json: {
                    result: JSON.stringify({
                        id: "firstwhite",
                        username: "FirstWhite",
                        title: "IM",
                        profile: { realName: "First White", flag: "DE" },
                        count: { rated: 4321 },
                    }),
                },
            },
        });
        const preview = await openFirstWhiteCard(page);
        const strip = preview.locator("[data-opponent-accounts]");
        await expect(strip).toContainText("Online accounts");
        // Below the split breakpoint the card keeps a minimum width inside its scrolling pane.
        await assertNothingClipped(strip, { mode: "reachable" });

        await strip.getByRole("button", { name: "Add online account", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Add online account", exact: true });
        await dialog.getByRole("textbox", { name: "Username" }).fill("firstwhite");
        await dialog.getByRole("button", { name: "Look up", exact: true }).click();
        const profile = dialog.locator("[data-opponent-profile]");
        await expect(profile).toContainText("FirstWhite");
        await expect(profile).toContainText("IM");
        await expect(profile).toContainText("First White, DE");
        await expect(profile).toContainText("4321 rated games");
        const lookups = await page.evaluate(() =>
            window.__E2E_TAURI__
                .invocations()
                .filter(({ command }) => command === "get_public_lichess_json")
                .map(({ args }) => args),
        );
        expect(lookups).toEqual([{ request: { kind: "account", username: "firstwhite" } }]);
        await assertNothingClipped(dialog);
        await assertNoHorizontalOverflow();
        await waitForFontsSettled(page);
        await profile.scrollIntoViewIfNeeded();
        await expect(page).toHaveScreenshot(`opponent-account-confirm-${surface.width}.png`);

        await dialog.getByRole("button", { name: "Link account", exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(strip).toContainText("FirstWhite");
        await expect(strip.locator("[data-opponent-status]")).toHaveText("No games downloaded");
        // A new link opens on its settings: the last three years, every time control but bullet.
        await expect(strip.locator("[data-opponent-details]")).toBeVisible();
        await expect(strip.getByRole("textbox", { name: "Since" })).toHaveValue("3 years");
        await expect(strip.getByRole("checkbox", { name: "Bullet" })).not.toBeChecked();
        for (const control of ["Blitz", "Rapid", "Classical", "Correspondence"]) {
            await expect(strip.getByRole("checkbox", { name: control })).toBeChecked();
        }
        const stored = await page.evaluate(() =>
            JSON.parse(localStorage.getItem("opponent-links") ?? "[]"),
        );
        expect(stored).toMatchObject([
            {
                playerName: "First White",
                accounts: [{ provider: "lichess", username: "FirstWhite" }],
                filter: {
                    years: 3,
                    timeControls: ["blitz", "rapid", "classical", "correspondence"],
                },
            },
        ]);
        await assertNothingClipped(strip, { mode: "reachable" });
        await assertNoHorizontalOverflow();
        await page.mouse.move(0, 0);
        await strip.evaluate((node) => node.scrollIntoView({ block: "start", inline: "start" }));
        await expect(page).toHaveScreenshot(`opponent-accounts-linked-${surface.width}.png`);
    });
}

test("database-files: an opponent's downloaded online games show their count beside the accounts", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
}) => {
    await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [
        "opponent-links",
        JSON.stringify([opponentLink]),
    ] as const);
    await page.addInitScript(() => localStorage.setItem("font-size", "100"));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.clock.setFixedTime(new Date("2026-11-08T12:00:00Z"));
    await mockScenario({
        commands: {
            ...databaseLayoutCommands,
            ...opponentDatabaseCommands,
        },
    });
    const preview = await openFirstWhiteCard(page);
    const strip = preview.locator("[data-opponent-accounts]");
    await expect(strip.locator("[data-opponent-status]")).toHaveText("1234 online games");
    await expect(strip).toContainText("FirstWhite");
    await expect(strip).toContainText("first_white");
    await expect(strip.getByRole("button", { name: "Update games", exact: true })).toBeVisible();
    await expect(strip.locator("[data-opponent-details]")).toHaveCount(0);
    // Both usernames resolve to one player of the opponent's database, so nothing is noted.
    await expect(strip.locator("[data-opponent-separate]")).toHaveCount(0);

    await strip.getByRole("button", { name: "Manage online accounts", exact: true }).click();
    await expect(strip.getByRole("textbox", { name: "Since" })).toHaveValue("5 years");
    await expect(strip.getByRole("button", { name: "Remove online games" })).toBeEnabled();
    await strip.getByRole("button", { name: "Remove online games", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "Remove online games", exact: true });
    await expect(confirmation).toContainText(
        "The downloaded online games of First White are deleted. The linked accounts stay.",
    );
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(confirmation).toBeHidden();
    await assertNothingClipped(strip, { mode: "reachable" });
    await assertNoHorizontalOverflow();
    await waitForFontsSettled(page);
    await page.mouse.move(0, 0);
    await expect(page).toHaveScreenshot("opponent-accounts-downloaded.png");
});

test("database-files: updating an opponent's online games shows the live game count on the card", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
    assertAccessible,
}) => {
    await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [
        "opponent-links",
        JSON.stringify([opponentLink]),
    ] as const);
    await page.addInitScript(() => localStorage.setItem("font-size", "100"));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.clock.setFixedTime(new Date("2026-11-08T12:00:00Z"));
    await mockScenario({
        commands: {
            ...databaseLayoutCommands,
            ...opponentDatabaseCommands,
            prepare_download: { result: "player-card-ticket" },
            release_download: { result: null },
            get_progress: { result: null },
            // The update stays running for the whole test.
            import_opponent_games: { delay: 60000, result: { kind: "noGames" } },
        },
    });
    const preview = await openFirstWhiteCard(page);
    const strip = preview.locator("[data-opponent-accounts]");
    await strip.getByRole("button", { name: "Update games", exact: true }).click();
    // The card's own status line says "Downloading online games"; the count line is the other one.
    await expect(strip.locator("[data-opponent-status]")).toHaveText("Downloading online games");
    const status = strip.locator('[role="status"]:not([data-opponent-status])');
    await expect(status).toHaveText("Loading games…");
    // useProgress hydrates only after its listener is registered, so the event cannot be missed.
    await expect
        .poll(() =>
            page.evaluate(() =>
                window.__E2E_TAURI__
                    .invocations()
                    .some(
                        ({ command, args }) =>
                            command === "get_progress" &&
                            (args as { id: string }).id === "player-card-ticket",
                    ),
            ),
        )
        .toBe(true);
    await page.evaluate(() =>
        window.__E2E_TAURI__.emit("progress-event", {
            id: "player-card-ticket",
            generation: "1",
            state: "running",
            progress: 0,
            finished: false,
            cleared: false,
            count: 1234,
        }),
    );
    await expect(status).toHaveText("1,234 games loaded");
    await expect(strip).not.toContainText("%");
    await assertNothingClipped(strip, { mode: "reachable" });
    await assertNoHorizontalOverflow();
    await assertAccessible();
    await waitForFontsSettled(page);
    await page.mouse.move(0, 0);
    await expect(strip).toHaveScreenshot("opponent-accounts-games-loaded.png", {
        animations: "disabled",
    });
});

test("database-files: the card's Overview and Ratings switch to a linked opponent's online games", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
}) => {
    await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [
        "opponent-links",
        JSON.stringify([opponentLink]),
    ] as const);
    await page.addInitScript(() => localStorage.setItem("font-size", "100"));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.clock.setFixedTime(new Date("2026-11-08T12:00:00Z"));
    const day = (date: string, timeControl: string, won: number, lost: number, elo: number) => ({
        date,
        time_control: timeControl,
        won,
        drawn: 0,
        lost,
        max_player_elo: elo,
    });
    const colorRow = (timeControl: string, white: boolean, won: number, lost: number) => ({
        time_control: timeControl,
        is_player_white: white,
        won,
        drawn: 0,
        lost,
        rated_won: won,
        rated_drawn: 0,
        rated_lost: lost,
        opponent_elo_sum: (won + lost) * 2000,
    });
    const onlineStatistics = {
        site_stats_data: [
            {
                site: "Lichess",
                player: "FirstWhite",
                daily: [
                    day("2026.10.20", "180+0", 6, 2, 2110),
                    day("2026.11.01", "180+0", 4, 3, 2140),
                    day("2026.11.02", "600+0", 1, 0, 1980),
                ],
                openings: [],
                colors: [
                    colorRow("180+0", true, 6, 2),
                    colorRow("180+0", false, 4, 3),
                    colorRow("600+0", true, 1, 0),
                ],
                latest: [],
            },
            {
                site: "Chess.com",
                player: "first_white",
                daily: [day("2026.09.15", "600", 2, 1, 1890)],
                openings: [],
                colors: [colorRow("600", true, 2, 1)],
                latest: [],
            },
        ],
    };
    await mockScenario({
        commands: {
            ...databaseLayoutCommands,
            ...opponentDatabaseCommands,
            get_progress: { result: null },
            get_players_game_info: {
                ...databaseLayoutCommands.get_players_game_info,
                byDatabase: { "opponent-online-db": onlineStatistics },
            },
        },
    });
    const preview = await openFirstWhiteCard(page);
    const overview = preview.getByRole("tabpanel", { name: "Overview", exact: true });
    const source = overview.locator("[data-statistics-source]");
    // The over-the-board games come first; the count on Online says that games arrived.
    await expect(
        source.getByRole("radio", { name: "Over the board · 1", exact: true }),
    ).toBeChecked();
    await expect(source.getByRole("radio", { name: "Online · 19", exact: true })).not.toBeChecked();
    await expect(preview.getByTestId("overview-headline")).toContainText("1 Games");

    await source.getByText("Online · 19", { exact: true }).click();
    await expect(preview.getByTestId("overview-headline")).toContainText("19 Games");
    await expect(preview.getByTestId("overview-ratings")).toContainText("Peak: 2140");
    // The online games come from two sites, so the Website filter appears.
    await expect(overview.getByRole("textbox", { name: "Website", exact: true })).toHaveValue(
        "All websites",
    );
    // The online player's statistics are read in the online games database.
    const reads = await page.evaluate(() =>
        window.__E2E_TAURI__
            .invocations()
            .filter(({ command }) => command === "get_players_game_info")
            .map(({ args }) => (args as { file: { id: { id: string } } }).file.id.id),
    );
    expect(reads).toContain("opponent-online-db");
    await assertNoHorizontalOverflow();
    await waitForFontsSettled(page);
    await page.mouse.move(0, 0);
    await expect(overview).toHaveScreenshot("opponent-card-online-overview.png");

    await preview.getByRole("tab", { name: "Ratings", exact: true }).click();
    const ratings = preview.getByRole("tabpanel", { name: "Ratings", exact: true });
    // The choice holds across the tabs; the rating curve starts on the busiest site and category.
    await expect(
        ratings
            .locator("[data-statistics-source]")
            .getByRole("radio", { name: "Online · 19", exact: true }),
    ).toBeChecked();
    await expect(ratings.getByRole("textbox", { name: "Website", exact: true })).toHaveValue(
        "Lichess",
    );
    await expect(ratings.getByRole("textbox", { name: "Time control", exact: true })).toHaveValue(
        "Blitz",
    );
    await expect(ratings).toContainText("15 Games");
    // The date-range tabs are one row: the card's tab floor does not reach the tabs nested in it.
    const dateRanges = ratings.getByRole("tablist").filter({ hasText: "All time" });
    const [rowHeight, rangesHeight] = await dateRanges.evaluate((list) => [
        list.getBoundingClientRect().height,
        list.parentElement!.getBoundingClientRect().height,
    ]);
    expect(rangesHeight).toBeLessThan(rowHeight * 2);
    await expect(page.getByText(/Unexpected Tauri IPC command:/)).toHaveCount(0);
});

async function openPreparedFirstWhiteCard(
    page: Page,
    mockScenario: MockScenario,
    options: { signedIn?: boolean } = {},
) {
    const referenceDbHandle = { id: { id: "reference-mega-db" }, kind: "database" as const };
    const signedIn = options.signedIn === true;
    await page.addInitScript(
        ([linkKey, linkValue, refKey, refValue, sessions]) => {
            localStorage.setItem("font-size", "100");
            // The explorer opens on its controls, where each column names its database.
            localStorage.setItem("explorer-header-collapsed", "false");
            localStorage.setItem(linkKey, linkValue);
            localStorage.setItem(refKey, refValue);
            if (sessions) localStorage.setItem("sessions", sessions);
        },
        [
            "opponent-links",
            JSON.stringify([opponentLink]),
            "reference-database",
            JSON.stringify(referenceDbHandle),
            signedIn ? lichessExplorerSession : null,
        ] as const,
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.clock.setFixedTime(new Date("2026-11-08T12:00:00Z"));
    const row = (
        move: string,
        white: number,
        draw: number,
        black: number,
        extras: {
            last_played?: string | null;
            year_counts?: { year: number; count: number }[];
            recent?: { date: string; game_id: number }[];
        } = {},
    ) => ({
        move,
        white,
        draw,
        black,
        unknown: 0,
        last_played: extras.last_played ?? null,
        year_counts: extras.year_counts ?? [],
        recent: extras.recent ?? [],
    });
    const [game] = gameOpeningFixture.games;
    const baseEntries = (
        opponentDatabaseCommands.list_workspace_databases as {
            result: { entries: unknown[]; unread: unknown[] };
        }
    ).result.entries;
    const baseDbInfoByDb = (
        opponentDatabaseCommands.get_db_info as {
            byDatabase: Record<string, unknown>;
        }
    ).byDatabase;
    await mockScenario({
        commands: {
            ...databaseLayoutCommands,
            ...opponentDatabaseCommands,
            list_workspace_databases: {
                result: {
                    entries: [
                        ...baseEntries,
                        {
                            handle: referenceDbHandle,
                            filename: "mega-reference.db3",
                            availability: "available",
                        },
                    ],
                    unread: [],
                },
            },
            get_db_info: {
                ...opponentDatabaseCommands.get_db_info,
                byDatabase: {
                    ...baseDbInfoByDb,
                    "reference-mega-db": {
                        status: "ready",
                        filename: "mega-reference.db3",
                        title: "Mega Reference",
                        description: "",
                        game_count: 50000,
                        player_count: 10000,
                        event_count: 500,
                        storage_size: "65536",
                        indexed: true,
                    },
                },
            },
            get_progress: { result: null },
            get_player: { result: { id: 1, name: "First White", elo: 1500, game_count: 12 } },
            search_position: {
                result: [
                    [
                        row("e4", 5, 2, 1, {
                            last_played: "2026.10.15",
                            year_counts: [
                                { year: 2024, count: 2 },
                                { year: 2025, count: 3 },
                                { year: 2026, count: 3 },
                            ],
                            recent: [
                                { date: "2026.10.15", game_id: 12 },
                                { date: "2026.05.12", game_id: 11 },
                                { date: "2025.11.02", game_id: 9 },
                            ],
                        }),
                        row("d4", 2, 1, 1, {
                            last_played: "2026.02.18",
                            year_counts: [
                                { year: 2025, count: 2 },
                                { year: 2026, count: 2 },
                            ],
                            recent: [{ date: "2026.02.18", game_id: 10 }],
                        }),
                    ],
                    [game],
                ],
                byDatabase: {
                    "opponent-online-db": [
                        [
                            row("e4", 310, 40, 250, {
                                last_played: "2026.09.20",
                                year_counts: [
                                    { year: 2024, count: 200 },
                                    { year: 2025, count: 250 },
                                    { year: 2026, count: 150 },
                                ],
                                recent: [
                                    { date: "2026.09.20", game_id: 95 },
                                    { date: "2026.08.11", game_id: 94 },
                                ],
                            }),
                            row("b3", 120, 10, 95, {
                                last_played: "2026.11.06",
                                year_counts: [
                                    { year: 2025, count: 40 },
                                    { year: 2026, count: 185 },
                                ],
                                recent: [
                                    { date: "2026.11.06", game_id: 106 },
                                    { date: "2026.11.04", game_id: 105 },
                                    { date: "2026.10.28", game_id: 104 },
                                    { date: "2026.10.21", game_id: 103 },
                                    { date: "2026.10.14", game_id: 102 },
                                    { date: "2026.10.07", game_id: 101 },
                                    { date: "2026.10.01", game_id: 100 },
                                ],
                            }),
                            row("d4", 4, 0, 5, {
                                last_played: "2026.07.01",
                                year_counts: [
                                    { year: 2024, count: 5 },
                                    { year: 2026, count: 4 },
                                ],
                                recent: [{ date: "2026.07.01", game_id: 90 }],
                            }),
                        ],
                        [{ ...game, id: 900, black: "online_rival", event: "Rated Blitz game" }],
                    ],
                    "reference-mega-db": [
                        [
                            row("e4", 12000, 8000, 9000),
                            row("d4", 10000, 7500, 6500),
                            row("c4", 3200, 2100, 1800),
                        ],
                        [game],
                    ],
                },
            },
            ...(signedIn ? lichessExplorerCommands : {}),
        },
    });
    return openFirstWhiteCard(page);
}

async function prepareFirstWhiteOnBoard(
    page: Page,
    mockScenario: MockScenario,
    options: { signedIn?: boolean } = {},
) {
    const preview = await openPreparedFirstWhiteCard(page, mockScenario, options);
    await preview.getByRole("tab", { name: "Openings", exact: true }).click();
    const tree = preview.locator("[data-player-opening-tree]");
    return { tree, preview };
}

test("database-files: Overview Prepare on board opens the start position with all three explorer columns", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
}) => {
    const preview = await openPreparedFirstWhiteCard(page, mockScenario);
    const overview = preview.getByRole("tabpanel", { name: "Overview", exact: true });
    await overview.getByRole("button", { name: "Prepare on board", exact: true }).click();
    await expect(page).toHaveURL("/");

    const sources = page.locator("[data-explorer-source]");
    await expect(sources).toHaveCount(3);
    await expect(sources.nth(0).getByRole("textbox")).toHaveValue(gameOpeningFixture.databaseTitle);
    await expect(sources.nth(1)).toContainText("First White (online)");
    await expect(sources.nth(2)).toContainText("Mega Reference");
    await expect(page.getByRole("cell", { name: "e4", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "b3", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "c4", exact: true })).toBeVisible();
    await expect(
        page.locator("#bottomRight").getByRole("button", { name: "e4", exact: true }),
    ).toHaveCount(0);
    await assertNoHorizontalOverflow();
    await expect(page.getByText(/Unexpected Tauri IPC command:/)).toHaveCount(0);
});

test("database-files: Prepare on board shows a linked opponent's over-the-board, online, and reference databases side by side", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
}) => {
    const { tree } = await prepareFirstWhiteOnBoard(page, mockScenario);
    // The card shows the online games as their own section beside the over-the-board games.
    const overTheBoard = tree.locator('[data-opening-section="primary"]');
    const online = tree.locator('[data-opening-section="online"]');
    await expect(overTheBoard).toContainText("Over the board");
    await expect(overTheBoard.locator("[data-opening-moves]")).toContainText("e4");
    await expect(overTheBoard.locator("[data-opening-moves]")).not.toContainText("b3");
    await expect(online).toContainText("Online");
    await expect(online.locator("[data-opening-moves]")).toContainText("b3");
    await expect(tree.locator("[data-opening-recent-summary]")).toHaveText(
        "Recently: Over the board e4 (3 of 4) · Online b3 (7 of 10)",
    );
    expect(await splitTextWords(tree.locator("th, [data-opening-column-label]"))).toEqual([]);
    expect(await openingHeaderOverlaps(tree)).toEqual([]);
    await expect(tree.locator('[data-opening-games-section="online"]')).toContainText(
        "online_rival",
    );
    await waitForFontsSettled(page);
    const summaryFonts = await tree.locator("[data-opening-recent-summary]").evaluate((summary) => {
        const moveSpans = [...summary.querySelectorAll("span")].filter(
            (span) => span.textContent === "e4" || span.textContent === "b3",
        );
        return {
            summary: getComputedStyle(summary).fontFamily,
            moves: moveSpans.map((span) => getComputedStyle(span).fontFamily),
        };
    });
    expect(summaryFonts.moves).toHaveLength(2);
    for (const moveFont of summaryFonts.moves) {
        expect(moveFont).not.toBe(summaryFonts.summary);
    }
    // The board beside both move tables, as the card lays out the two sections.
    await expect(tree.locator("[data-opening-body]")).toHaveScreenshot(
        "opponent-card-sections.png",
    );
    await tree.getByRole("button", { name: "Prepare on board", exact: true }).click();
    await expect(page).toHaveURL("/");

    const sources = page.locator("[data-explorer-source]");
    await expect(sources).toHaveCount(3);
    // The first column can be exchanged; online games and reference database are fixed titles.
    await expect(sources.nth(0).getByRole("textbox")).toHaveValue(gameOpeningFixture.databaseTitle);
    await expect(sources.nth(1)).toContainText("First White (online)");
    await expect(sources.nth(1).getByRole("textbox")).toHaveCount(0);
    await expect(
        sources.nth(1).getByRole("button", { name: "Remove comparison database", exact: true }),
    ).toBeVisible();
    await expect(sources.nth(2)).toContainText("Mega Reference");
    await expect(sources.nth(2).getByRole("textbox")).toHaveCount(0);
    await expect(
        sources.nth(2).getByRole("button", { name: "Remove reference database", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("cell", { name: "b3", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "c4", exact: true })).toBeVisible();
    // Each database is searched with its own player filter (none for the reference database).
    const searches = await page.evaluate(() =>
        window.__E2E_TAURI__
            .invocations()
            .filter(({ command }) => command === "search_position")
            .map(({ args }) => {
                const { file, query } = args as {
                    file: { id: { id: string } };
                    query: { player1?: number };
                };
                return `${file.id.id}:${query.player1 ?? "none"}`;
            }),
    );
    expect(searches).toContain(`${gameOpeningFixture.databaseId}:1`);
    expect(searches).toContain("opponent-online-db:1");
    expect(searches).toContain("reference-mega-db:none");
    const lookups = await page.evaluate(() =>
        window.__E2E_TAURI__
            .invocations()
            .filter(
                ({ command, args }) =>
                    command === "get_players" &&
                    (args as { file: { id: { id: string } } }).file.id.id === "opponent-online-db",
            )
            .map(({ args }) => (args as { query: { name?: string } }).query.name),
    );
    expect(lookups.slice(-2)).toEqual(["FirstWhite", "first_white"]);

    const comparisonFilters = sources.nth(1).getByRole("button", { name: /^Filters:/ });
    await comparisonFilters.click();
    const filters = page.locator("[data-explorer-filters]");
    await page.keyboard.press("Escape");
    await expect(filters).toHaveCount(0);
    await comparisonFilters.click();
    await expect(filters.getByRole("radio", { name: "White", exact: true })).toBeChecked();
    await expect(filters.getByRole("textbox", { name: "Search" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(filters).toHaveCount(0);
    await expect(page.getByText(/Unexpected Tauri IPC command:/)).toHaveCount(0);
    // All three headers end on one line: the titled columns are as tall as the selectable one.
    const bottoms = await sources.evaluateAll((cells) =>
        cells.map((cell) => Math.round(cell.getBoundingClientRect().bottom)),
    );
    expect(bottoms[1]).toBe(bottoms[0]);
    expect(bottoms[2]).toBe(bottoms[0]);
    const assertTableFitsPanel = async () => {
        const overflow = await page.evaluate(() => {
            const table = document.querySelector<HTMLElement>(".mantine-datatable-table");
            const scroll =
                table?.closest<HTMLElement>(".mantine-ScrollArea-viewport") ?? table?.parentElement;
            if (!table || !scroll) return { ok: false, tableWidth: 0, containerWidth: 0 };
            return {
                ok: table.scrollWidth <= scroll.clientWidth + 1,
                tableWidth: table.scrollWidth,
                containerWidth: scroll.clientWidth,
            };
        });
        expect(
            overflow.ok,
            `table overflows panel: ${overflow.tableWidth}px > ${overflow.containerWidth}px`,
        ).toBe(true);
    };
    await assertNoHorizontalOverflow();
    await assertTableFitsPanel();
    await waitForFontsSettled(page);
    // The filter button keeps the focus the closed popover returned to it.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.mouse.move(0, 0);
    await expect(page).toHaveScreenshot("opponent-board-columns.png");

    // Also fits without horizontal overflow at 800 x 720.
    await page.setViewportSize({ width: 800, height: 720 });
    await assertNoHorizontalOverflow();
    await assertTableFitsPanel();
});

test("database-files: Prepare on board replaces the reference column with Lichess All", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
}) => {
    const { tree } = await prepareFirstWhiteOnBoard(page, mockScenario, { signedIn: true });
    await expect(tree.locator('[data-opening-section="online"]')).toContainText("Online");
    await tree.getByRole("button", { name: "Prepare on board", exact: true }).click();
    await expect(page).toHaveURL("/");

    const sources = page.locator("[data-explorer-source]");
    await expect(sources).toHaveCount(3);
    await sources
        .nth(2)
        .getByRole("button", { name: "Remove reference database", exact: true })
        .click();
    await expect(sources).toHaveCount(2);
    await page.getByRole("button", { name: "Add column", exact: true }).click();
    await expect(page.getByRole("menuitem")).toHaveText([
        "Mega Reference",
        "Lichess All",
        "Lichess Masters",
    ]);
    await page.getByRole("menuitem", { name: "Lichess All", exact: true }).click();
    await expect(sources).toHaveCount(3);
    await expect(sources.nth(2)).toContainText("Lichess All");
    await expect(sources.nth(2).getByRole("textbox")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add column", exact: true })).toHaveCount(0);
    await expect(
        sources.nth(2).getByRole("button", { name: "Remove column", exact: true }),
    ).toBeVisible();

    const stats = page.getByRole("region", { name: "Stats", exact: true });
    const totals = stats.locator("tbody tr").last().locator("td");
    await expect(totals.nth(7)).toHaveText("200");
    await expect(page.locator('[data-sources="3"]')).toBeVisible();
    await expectExplorerSourcesAligned(page, 3);
    await assertNoHorizontalOverflow();
    await waitForFontsSettled(page);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.mouse.move(0, 0);
    await expect(page.getByRole("tabpanel", { name: "Database", exact: true })).toHaveScreenshot(
        "opponent-board-lichess-column.png",
    );
    await expect(page.getByText(/Unexpected Tauri IPC command:/)).toHaveCount(0);
});

test("database-files: board explorer split view shows notation, divider resize, short viewport and internal scroll", async ({
    page,
    mockScenario,
}) => {
    const mega = { id: { id: gameOpeningFixture.databaseId }, kind: "database" as const };
    const startFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const fullLine = "1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 6. Be3 e5 7. Nb3 Be6";
    const fullLineSymbols =
        "1. e4 c5 2. ♘f3 d6 3. d4 cxd4 4. ♘xd4 ♘f6 5. ♘c3 a6 6. ♗e3 e5 7. ♘b3 ♗e6";
    const moveRows = ["e4", "d4", "c4", "Nf3", "g3", "b3", "f4", "Nc3", "b4", "e3", "d3", "a3"].map(
        (move, index) => ({
            move,
            white: 200 - index * 10,
            draw: 80,
            black: 150 - index * 5,
            unknown: 0,
            last_played: null,
            year_counts: [],
            recent: [],
        }),
    );
    const gamesList = [
        {
            ...gameOpeningFixture.games[0],
            id: 501,
            fen: startFen,
            white: "Carlsen, Magnus",
            black: "Caruana, Fabiano",
            date: "2024.06.10",
            result: "1-0",
            moves: `${fullLine} *`,
        },
        {
            ...gameOpeningFixture.games[1],
            id: 502,
            fen: startFen,
            white: "Nakamura, Hikaru",
            black: "Firouzja, Alireza",
            date: "2024.07.15",
            result: "1/2-1/2",
            moves: "1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. e3 O-O 5. Bd3 d5 6. Nf3 c5 *",
        },
    ];

    await page.addInitScript((saved) => {
        localStorage.setItem("reference-database", JSON.stringify(saved));
        localStorage.setItem("font-size", "100");
    }, mega);
    await page.setViewportSize({ width: 1280, height: 1000 });
    await mockScenario({
        commands: filesWorkspaceCommands([[]], {
            ...gameOpeningCommands,
            list_workspace_databases: {
                result: {
                    entries: [{ handle: mega, filename: "mega.db3", availability: "available" }],
                    unread: [],
                },
            },
            get_progress: { result: null },
            linked_collections_supported: { result: true },
            list_linked_collections: { result: [] },
            search_position: { result: [moveRows, gamesList] },
        }),
    });

    await page.goto("/library");
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    await expect(page.getByRole("button", { name: "Open database", exact: true })).toBeVisible();
    await goToBoards(page);
    await page.getByRole("button", { name: /^Analysis Board$/ }).click();
    await page.getByRole("tab", { name: "Database", exact: true }).click();

    const databasePanel = page.getByRole("tabpanel", { name: "Database", exact: true });
    const stats = databasePanel.getByRole("region", { name: "Stats", exact: true });
    const games = databasePanel.getByRole("region", { name: "Games", exact: true });
    const separator = databasePanel.getByRole("separator", {
        name: "Resize statistics and games",
        exact: true,
    });
    await expect(stats).toBeVisible();
    await expect(games).toBeVisible();
    await expect(separator).toBeVisible();
    await expect(databasePanel.getByRole("tab")).toHaveCount(0);

    // Games table headers: Notation present, Plies absent.
    await expect(games.getByRole("columnheader", { name: "Notation", exact: true })).toBeVisible();
    await expect(games.getByRole("columnheader", { name: "Plies", exact: true })).toHaveCount(0);

    // Notation cell from start position: bold first move, 8-ply preview, full line in title.
    const firstNotation = games.locator("tbody tr").first().locator("td").nth(2).locator("span");
    await expect(firstNotation.locator("strong")).toHaveText("e4");
    await expect(firstNotation).toHaveText("1. e4 c5 2. ♘f3 d6 3. d4 cxd4 4. ♘xd4 ♘f6 …");
    await expect(firstNotation).toHaveAttribute("title", fullLineSymbols);

    // No horizontal overflow in Games table; Date and Result stay visible.
    const gamesMetrics = await games.evaluate((region) => {
        const viewport = region.querySelector<HTMLElement>(".mantine-ScrollArea-viewport");
        const table = region.querySelector<HTMLElement>("table");
        if (!viewport || !table) return null;
        const viewportRect = viewport.getBoundingClientRect();
        const headers = [...region.querySelectorAll("thead th")];
        const dateHeader = headers[3]?.getBoundingClientRect();
        const resultHeader = headers[4]?.getBoundingClientRect();
        return {
            tableScrollWidth: table.scrollWidth,
            viewportClientWidth: viewport.clientWidth,
            dateVisible:
                !!dateHeader && dateHeader.width > 0 && dateHeader.right <= viewportRect.right + 1,
            resultVisible:
                !!resultHeader &&
                resultHeader.width > 0 &&
                resultHeader.right <= viewportRect.right + 1,
        };
    });
    expect(gamesMetrics).not.toBeNull();
    expect(gamesMetrics!.tableScrollWidth).toBeLessThanOrEqual(
        gamesMetrics!.viewportClientWidth + 1,
    );
    expect(gamesMetrics!.dateVisible).toBe(true);
    expect(gamesMetrics!.resultVisible).toBe(true);

    // Statistics table scrolls inside its region with scrollbar offset off the last column.
    const statsMetrics = await stats.evaluate((region) => {
        const viewport = region.querySelector<HTMLElement>(".mantine-ScrollArea-viewport");
        const table = region.querySelector<HTMLElement>("table");
        const regionRect = region.getBoundingClientRect();
        const lastHeader = [...region.querySelectorAll("thead th")].at(-1)?.getBoundingClientRect();
        if (!viewport || !table || !lastHeader) return null;
        const viewportRect = viewport.getBoundingClientRect();
        const viewportStyle = getComputedStyle(viewport);
        const paddingEnd = Number.parseFloat(viewportStyle.paddingInlineEnd) || 0;
        const scrollbarSize =
            Number.parseFloat(viewportStyle.getPropertyValue("--scrollarea-scrollbar-size")) || 0;
        return {
            scrollHeight: viewport.scrollHeight,
            clientHeight: viewport.clientHeight,
            viewportBottom: viewportRect.bottom,
            regionBottom: regionRect.bottom,
            lastHeaderRight: lastHeader.right,
            viewportRight: viewportRect.right,
            paddingEnd,
            scrollbarSize,
        };
    });
    expect(statsMetrics).not.toBeNull();
    expect(statsMetrics!.scrollHeight).toBeGreaterThan(statsMetrics!.clientHeight);
    expect(statsMetrics!.viewportBottom).toBeLessThanOrEqual(statsMetrics!.regionBottom + 1);
    expect(statsMetrics!.paddingEnd).toBeGreaterThan(0);
    expect(statsMetrics!.paddingEnd).toBe(statsMetrics!.scrollbarSize);
    expect(statsMetrics!.lastHeaderRight).toBeLessThanOrEqual(
        statsMetrics!.viewportRight - statsMetrics!.paddingEnd + 1,
    );

    // Playing e4 updates the board position and anchors Notation on Black's reply in bold.
    await stats.locator("tbody tr").first().click();
    await expect(firstNotation.locator("strong")).toHaveText("c5");
    await expect(firstNotation).toHaveText("1... c5 2. ♘f3 d6 3. d4 cxd4 4. ♘xd4 ♘f6 5. ♘c3 …");
    await expect(firstNotation).toHaveAttribute(
        "title",
        "1... c5 2. ♘f3 d6 3. d4 cxd4 4. ♘xd4 ♘f6 5. ♘c3 a6 6. ♗e3 e5 7. ♘b3 ♗e6",
    );

    // Dragging the separator and pressing ArrowDown updates height and survives reload.
    const beforeValue = Number(await separator.getAttribute("aria-valuenow"));
    const beforeBox = (await stats.boundingBox())!;
    const sepBox = (await separator.boundingBox())!;
    await page.mouse.move(sepBox.x + sepBox.width / 2, sepBox.y + sepBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(sepBox.x + sepBox.width / 2, sepBox.y + sepBox.height / 2 - 48, {
        steps: 4,
    });
    await page.mouse.up();
    const afterDragValue = Number(await separator.getAttribute("aria-valuenow"));
    expect(afterDragValue).toBeLessThan(beforeValue);
    expect((await stats.boundingBox())!.height).toBeLessThan(beforeBox.height - 30);

    await separator.focus();
    await page.keyboard.press("ArrowDown");
    await expect(separator).toHaveAttribute("aria-valuenow", String(afterDragValue + 1));
    const storedAfterKey = await page.evaluate(() => localStorage.getItem("explorer-stats-height"));
    expect(Number(storedAfterKey)).toBe(afterDragValue + 1);

    await preserveStorageForReload(page);
    await page.getByRole("tab", { name: "Database", exact: true }).click();
    await expect(
        databasePanel.getByRole("separator", {
            name: "Resize statistics and games",
            exact: true,
        }),
    ).toHaveAttribute("aria-valuenow", String(afterDragValue + 1));

    // Short viewport shares height without overlap and never overwrites the stored height on key press.
    await page.setViewportSize({ width: 1280, height: 420 });
    const shortSep = databasePanel.getByRole("separator", {
        name: "Resize statistics and games",
        exact: true,
    });
    await expect
        .poll(async () => {
            const min = await shortSep.getAttribute("aria-valuemin");
            const max = await shortSep.getAttribute("aria-valuemax");
            const now = await shortSep.getAttribute("aria-valuenow");
            return min !== null && min === max && now === min;
        })
        .toBe(true);

    const panelBox = (await databasePanel.boundingBox())!;
    const shortStatsBox = (await stats.boundingBox())!;
    const shortGamesBox = (await games.boundingBox())!;
    expect(shortStatsBox.y).toBeGreaterThanOrEqual(panelBox.y - 1);
    expect(shortStatsBox.y + shortStatsBox.height).toBeLessThanOrEqual(shortGamesBox.y + 1);
    expect(shortGamesBox.y + shortGamesBox.height).toBeLessThanOrEqual(
        panelBox.y + panelBox.height + 1,
    );

    await shortSep.focus();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowDown");
    expect(await page.evaluate(() => localStorage.getItem("explorer-stats-height"))).toBe(
        storedAfterKey,
    );
});

test("database-files: the preview board keeps its place while stepping through a game", async ({
    page,
    mockScenario,
}) => {
    // Slow lookups answer no opening, then a name too long for one line, then no opening again, so
    // stepping crosses a pending lookup, empty to named, and named to empty.
    const noOpening = {
        error: {
            tag: "backend-error" as const,
            category: "missing-resource" as const,
            message: "No opening found",
        },
    };
    const longName = `King's Pawn Game: ${"Exceptionally Long Variation Name, ".repeat(8)}Main Line`;
    await mockScenario({
        commands: {
            ...databaseLayoutCommands,
            get_progress: { result: null },
            get_opening_from_fens: {
                delay: 300,
                outcomes: [noOpening, { result: longName }, noOpening],
            },
        },
    });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(`/databases/${gameOpeningFixture.databaseId}`);
    await page.getByRole("row").filter({ hasText: "First White" }).first().click();
    const board = page.locator("[data-preview-arrangement] cg-board").first();
    await expect(board).toBeVisible();
    const lookups = () =>
        page.evaluate(
            () =>
                window.__E2E_TAURI__
                    .invocations()
                    .filter(({ command }) => command === "get_opening_from_fens").length,
        );
    await expect.poll(lookups).toBe(1);
    // The start position's lookup is still delayed; the samples below must begin after it settled.
    await page.waitForTimeout(400);

    for (let step = 0; step < 2; step++) {
        // The board's offset from the preview's top (the opening line's container) on every frame,
        // from before the click until the lookup has answered. Measured inside the preview, a scroll
        // caused by the click can neither pass for a jump nor hide one.
        const offsets = board.evaluate(
            (element) =>
                new Promise<number[]>((resolve) => {
                    const preview = element.closest("[data-preview-arrangement]")!.parentElement!;
                    const samples: number[] = [];
                    const started = performance.now();
                    const sample = () => {
                        samples.push(
                            element.getBoundingClientRect().top -
                                preview.getBoundingClientRect().top,
                        );
                        if (performance.now() - started < 700) requestAnimationFrame(sample);
                        else resolve(samples);
                    };
                    requestAnimationFrame(sample);
                }),
        );
        await page.getByRole("button", { name: "Next move", exact: true }).click();
        const distinct = new Set(await offsets);
        expect(distinct.size, `board offsets ${[...distinct].join(", ")}`).toBe(1);
        if (step === 0) {
            // The long name is cut to one line and offered in full as the line's title.
            const name = page.getByText(longName, { exact: true });
            await expect(name).toHaveAttribute("title", longName);
            expect(await name.evaluate((line) => line.scrollWidth > line.clientWidth)).toBe(true);
        }
    }
    await expect(page.getByText(longName, { exact: true })).toHaveCount(0);
    expect(await lookups()).toBe(3);
});
