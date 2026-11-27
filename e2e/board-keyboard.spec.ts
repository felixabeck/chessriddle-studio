import {
    activeWorkspaceTab,
    assertChooserInsideBoard,
    assertNothingClipped,
    chooseBoardMoreAction,
    createLiveGameState,
    dragBoard,
    dragMosaicDivider,
    drawMark,
    expect,
    filesWorkspaceCommands,
    filesWorkspaceFixture,
    pgnFileCommands,
    playBoardMove,
    preserveStorageForReload,
    selectFilesTreeRow,
    test,
    waitForBoardSizeSettled,
    waitForFontsSettled,
    goToBoards,
    goToSettings,
} from "./fixtures";
import type { ErrorPayload } from "../src/bindings/generated";
import {
    deserializeStorageValue,
    serializeStorageValue,
} from "../src/state/store/debouncedStorage";
import type { Locator, Page } from "@playwright/test";
import type { TreeState } from "../src/utils/treeReducer";

for (const mode of ["diff", "all"] as const) {
    test(`board-material: ${mode} stays inside both player bars in both orientations`, async ({
        page,
        mockScenario,
    }, testInfo) => {
        await page.setViewportSize({ width: 1920, height: 900 });
        await page.addInitScript((value) => {
            localStorage.setItem("material-display", JSON.stringify(value));
            // This fixture exercises layout, without writing back to the mock collection.
            localStorage.setItem("auto-save", "false");
        }, mode);
        const headers = {
            White: "White player",
            Black: "Beck, Felix",
            BlackElo: "2077",
            Result: "0-1",
            SetUp: "1",
            FEN: "rnbqkbnr/1ppppppp/8/8/8/8/2PPPPPP/RNBQKBNR w KQkq - 0 1",
        };
        await mockScenario({
            commands: filesWorkspaceCommands([[filesWorkspaceFixture.pgnFile]], {
                ...pgnFileCommands,
                lex_pgn: {
                    result: [
                        ...Object.entries(headers).map(([tag, value]) => ({
                            type: "Header",
                            value: { tag, value },
                        })),
                        { type: "Outcome", value: "0-1" },
                    ],
                },
            }),
        });
        await page.goto("/library");
        await page.getByRole("button", { name: /choose folder/i }).click();
        await selectFilesTreeRow(page, filesWorkspaceFixture.pgnFile.name);
        await page.getByRole("button", { name: "Open game", exact: true }).click();
        await expect(page.getByRole("grid")).toBeVisible();
        await expect(page.getByText("+1", { exact: true })).toBeVisible();
        const measurements = [];
        for (const orientation of ["white", "black"]) {
            if (orientation === "black")
                await page.getByRole("button", { name: /^Flip Board/ }).click();
            await expect(page.getByRole("grid")).toHaveAccessibleName(
                `Chessboard, ${orientation === "white" ? "White" : "Black"} orientation`,
            );
            await waitForFontsSettled(page);
            const geometry = await page.locator("[data-board-surface]").evaluate((surface) => {
                const column = surface.parentElement!;
                const rect = (element: Element) => {
                    const { x, y, width, height, top, bottom, left, right } =
                        element.getBoundingClientRect();
                    return { x, y, width, height, top, bottom, left, right };
                };
                const clips = [];
                for (
                    let ancestor: Element | null = column;
                    ancestor;
                    ancestor = ancestor.parentElement
                ) {
                    const style = getComputedStyle(ancestor);
                    if (/hidden|clip/.test(style.overflowY)) clips.push(rect(ancestor));
                }
                return {
                    column: rect(column),
                    clips,
                    board: rect(surface.querySelector("cg-board")!),
                    bars: [column.firstElementChild!, column.lastElementChild!].map((bar) => ({
                        placement: bar.getAttribute("data-board-bar"),
                        bar: rect(bar),
                        name: rect(bar.querySelector("button")!),
                        indicators: Array.from(
                            bar.lastElementChild!.querySelectorAll("[data-material-piece], p"),
                        ).map((el) => ({
                            tag: el.hasAttribute("data-material-piece") ? "piece" : el.tagName,
                            text: el.textContent,
                            box: rect(el),
                        })),
                    })),
                };
            });
            measurements.push({ mode, orientation, ...geometry });
            await testInfo.attach(`${mode}-${orientation}-geometry`, {
                body: JSON.stringify(geometry, null, 2),
                contentType: "application/json",
            });
            await page.screenshot({ path: testInfo.outputPath(`${mode}-${orientation}.png`) });
            // The correction must recover spacing, without resizing the painted chessboard.
            expect(geometry.board.width).toBe(768);
            expect(geometry.board.height).toBe(768);
            const indicators = geometry.bars.flatMap((bar) => bar.indicators);
            expect(geometry.bars.map((bar) => bar.placement)).toEqual(["above", "below"]);
            expect(indicators.filter((indicator) => indicator.tag === "piece")).toHaveLength(
                mode === "all" ? 3 : 1,
            );
            expect(indicators.filter((indicator) => indicator.text === "+1")).toHaveLength(1);
            // Dark card: black pieces carry a light outline, white pieces need none.
            const filters = await page
                .locator("[data-material-piece]")
                .evaluateAll((pieces) =>
                    pieces.map((piece) => [
                        piece.getAttribute("data-material-piece")!.split("-")[0],
                        getComputedStyle(piece).filter,
                    ]),
                );
            expect(filters.length).toBeGreaterThan(0);
            for (const [color, filter] of filters) {
                if (color === "black") expect(filter).toContain("drop-shadow");
                else expect(filter).toBe("none");
            }
            for (const bar of geometry.bars) {
                for (const indicator of bar.indicators) {
                    for (const clip of geometry.clips) {
                        expect
                            .soft(
                                indicator.box.bottom,
                                JSON.stringify({ mode, orientation, indicator, clip }),
                            )
                            .toBeLessThanOrEqual(clip.bottom);
                        expect.soft(indicator.box.top).toBeGreaterThanOrEqual(clip.top);
                        expect.soft(indicator.box.left).toBeGreaterThanOrEqual(clip.left);
                        expect.soft(indicator.box.right).toBeLessThanOrEqual(clip.right);
                    }
                    expect.soft(indicator.box.bottom).toBeLessThanOrEqual(bar.bar.bottom);
                    // Bar content hugs the board: above it, pieces share the name's bottom edge;
                    // below it, they share its top edge and never reach lower than the name.
                    if (indicator.tag !== "piece") continue;
                    if (bar.placement === "above") {
                        expect(indicator.box.bottom).toBe(bar.name.bottom);
                    } else {
                        expect(indicator.box.top).toBe(bar.name.top);
                        expect(indicator.box.bottom).toBeLessThanOrEqual(bar.name.bottom + 0.5);
                    }
                }
            }
        }
        console.log("BOARD_MATERIAL_GEOMETRY", JSON.stringify(measurements));
    });
}

async function importAnalysisFen(page: Page, initialFen: string) {
    await page.goto("/");
    await page.getByRole("button", { name: /^import$/i }).click();
    const modal = page.getByRole("dialog", { name: /import game/i });
    await modal.getByRole("button", { name: "FEN", exact: true }).click();
    await modal.getByRole("textbox", { name: "FEN" }).fill(initialFen);
    await modal.getByRole("button", { name: /^import$/i }).click();
    const grid = page.getByRole("grid", { name: "Chessboard, White orientation", exact: true });
    await expect(grid).toBeVisible();
    return grid;
}

for (const timezoneId of ["America/Los_Angeles", "Europe/Berlin"]) {
    test.describe(`explorer calendar ${timezoneId}`, () => {
        test.use({ timezoneId });

        test("month and year picker selections survive the stored Date round-trip", async ({
            page,
            mockScenario,
        }) => {
            await page.setViewportSize({ width: 1440, height: 900 });
            await page.clock.setFixedTime(new Date("2024-06-15T12:00:00Z"));
            await page.addInitScript(
                (stored) => {
                    for (const [key, value] of Object.entries(stored))
                        localStorage.setItem(key, value);
                },
                {
                    sessions: serializeStorageValue([
                        {
                            updatedAt: Date.UTC(2024, 0, 1),
                            lichess: {
                                username: "calendar-player",
                                account: { id: "calendar-player", username: "calendar-player" },
                            },
                        },
                    ]),
                },
            );
            await mockScenario({
                commands: {
                    list_lichess_accounts: {
                        result: [{ handle: "calendar-account", username: "calendar-player" }],
                    },
                    get_authenticated_lichess_explorer: {
                        result: JSON.stringify({ white: 0, draws: 0, black: 0, moves: [] }),
                    },
                    get_progress: { result: null },
                },
            });
            await importAnalysisFen(
                page,
                "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            );
            await page.getByRole("tab", { name: "Database", exact: true }).click();
            // No local database is chosen yet, so the header's controls are open; with an
            // online source it collapses to its caption until the settings button opens it.
            await page.getByPlaceholder("add a database").click();
            await page.getByRole("option", { name: "Lichess All", exact: true }).click();
            await page.getByRole("button", { name: "Show database settings", exact: true }).click();
            const filterButton = page.getByRole("button", { name: /^Filters: / });
            await filterButton.click();
            const options = page.locator("[data-explorer-filters]");
            const since = options.getByLabel("From", { exact: true });
            const until = options.getByLabel("To", { exact: true });
            // One time zone pins the pixels; the picker behaviour below runs in both.
            const pinsLayout = timezoneId === "Europe/Berlin";
            if (pinsLayout) await expect(options).toHaveScreenshot("explorer-lichess-options.png");
            async function pickDate(input: Locator, name: string) {
                await input.click();
                const dropdown = page.locator("[data-dates-dropdown]");
                await dropdown.getByRole("button", { name, exact: true }).click();
                await expect(dropdown).toBeHidden();
            }
            await pickDate(since, "Jan");
            await pickDate(until, "Feb");
            await expect(since).toHaveText("January 2024");
            await expect(until).toHaveText("February 2024");
            await pickDate(since, "Mar");
            await expect(since).toHaveText("March 2024");
            await pickDate(since, "Jan");
            await expect(since).toHaveText("January 2024");

            await page.locator("[data-explorer-source]").first().getByRole("textbox").click();
            await page.getByRole("option", { name: "Lichess Masters", exact: true }).click();
            await expect(options).toBeHidden();
            await filterButton.click();
            if (pinsLayout) await expect(options).toHaveScreenshot("explorer-masters-options.png");
            await pickDate(since, "2024");
            await pickDate(until, "2024");
            await expect(since).toHaveText("2024");
            await expect(until).toHaveText("2024");
            await pickDate(since, "2023");
            await expect(since).toHaveText("2023");
            await pickDate(since, "2024");
            await expect(since).toHaveText("2024");
        });
    });
}

test("board-keyboard: annotation navigation keeps focus and comments on their moves", async ({
    page,
}) => {
    const grid = await importAnalysisFen(
        page,
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    );
    const board = page.locator("cg-board").first();
    await playBoardMove(page, board, "e2", "e4");
    await playBoardMove(page, board, "e7", "e5");
    await page.getByRole("tab", { name: "Annotate", exact: true }).click();
    await page.getByRole("button", { name: /^Previous move/ }).click();
    const editor = page.locator(".tiptap");
    await editor.click();
    await page.keyboard.type("first");
    const hint = page.getByText("tab: next move · shift+tab: previous move · Esc: leave editor", {
        exact: true,
    });
    await expect(hint).toBeVisible();
    await expect
        .poll(() =>
            hint.evaluate((element) => {
                const panel = element.closest<HTMLElement>(".mantine-ScrollArea-viewport")!;
                const frame = element.closest<HTMLElement>(".mantine-RichTextEditor-root")!;
                const hintBox = element.getBoundingClientRect();
                const panelBox = panel.getBoundingClientRect();
                const frameBox = frame.getBoundingClientRect();
                const text = document.createRange();
                text.selectNodeContents(element);
                const textBox = text.getBoundingClientRect();
                return {
                    insideRight: hintBox.right <= panelBox.right,
                    insideLeft: hintBox.left >= panelBox.left,
                    noHorizontalOverflow: element.scrollWidth <= element.clientWidth,
                    // The hint text keeps clear of the editor frame's border.
                    clearOfFrameLeft: textBox.left - frameBox.left >= 12,
                    clearOfFrameBottom: frameBox.bottom - textBox.bottom >= 6,
                };
            }),
        )
        .toEqual({
            insideRight: true,
            insideLeft: true,
            noHorizontalOverflow: true,
            clearOfFrameLeft: true,
            clearOfFrameBottom: true,
        });
    await page.keyboard.press("Tab");
    await expect(editor).toBeFocused();
    await expect(editor).toHaveText("");
    await page.keyboard.type("second");
    await page.keyboard.press("Shift+Tab");
    await expect(editor).toBeFocused();
    await expect(editor).toHaveText("first");
    await page.keyboard.type(" more");
    await expect(editor).toHaveText("first more");
    await page.keyboard.press("Escape");
    await expect(editor).not.toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(editor).toHaveText("second");
    await expect(editor).not.toBeFocused();
    await grid.focus();
    await page.keyboard.press("Tab");
    await expect(grid.getByRole("gridcell", { name: "e5, Black Pawn", exact: true })).toHaveCount(
        1,
    );
    await expect(editor).toHaveText("second");
});

async function expectEditorRoot(page: Page, expectedFen: string) {
    const tab = (await activeWorkspaceTab(page))!;
    await expect
        .poll(async () => {
            const raw = await page.evaluate(
                (key) => sessionStorage.getItem(key),
                tab.treeKey ?? tab.value,
            );
            return raw
                ? deserializeStorageValue<{
                      state: {
                          root: { fen: string; children: unknown[] };
                          headers: { fen: string };
                          position: number[];
                      };
                  }>(raw)?.state
                : null;
        })
        .toMatchObject({
            root: { fen: expectedFen, children: [] },
            headers: { fen: expectedFen },
            position: [],
        });
}

async function tablebaseGeometry(tablebase: Locator) {
    return tablebase.evaluate((element) => {
        const viewport = element.closest<HTMLElement>(".mantine-ScrollArea-viewport")!;
        const contentBounds = (node: Element) => {
            const box = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return {
                left: box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
                right:
                    box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight),
            };
        };
        // The viewport is assigned by AnalysisPanel, independently of the grid's intrinsic size.
        const bounds = contentBounds(viewport);
        const grid = element.querySelector<HTMLElement>(".mantine-SimpleGrid-root")!;
        const offenders: string[] = [];
        const contains = (
            name: string,
            box: { left: number; right: number },
            parent: typeof bounds,
        ) => {
            if (box.left < parent.left - 1 || box.right > parent.right + 1)
                offenders.push(
                    `${name}: [${box.left.toFixed(2)}, ${box.right.toFixed(2)}] outside [${parent.left.toFixed(2)}, ${parent.right.toFixed(2)}]`,
                );
        };
        contains("grid in ScrollArea", grid.getBoundingClientRect(), bounds);
        const cards = Array.from(grid.children, (card) => {
            const san = card.querySelector<HTMLElement>(".mantine-Text-root")!;
            const badge = card.querySelector<HTMLElement>(".mantine-Badge-root")!;
            const label = badge.querySelector<HTMLElement>(".mantine-Badge-label")!;
            const cardBounds = contentBounds(card);
            contains(`${san.textContent} card in ScrollArea`, card.getBoundingClientRect(), bounds);
            contains(`${san.textContent} badge in card`, badge.getBoundingClientRect(), cardBounds);
            const textWidths: Record<string, number> = {};
            for (const [name, node] of [
                ["SAN", san],
                ["badge label", label],
            ] as const) {
                const range = document.createRange();
                range.selectNodeContents(node);
                const textBox = range.getBoundingClientRect();
                textWidths[name] = textBox.width;
                for (const rect of range.getClientRects()) {
                    contains(
                        `${san.textContent} ${name} ${node.textContent} content fit`,
                        rect,
                        contentBounds(node),
                    );
                    contains(`${san.textContent} ${name} in card`, rect, cardBounds);
                    if (name === "badge label")
                        contains(`${san.textContent} label in badge`, rect, contentBounds(badge));
                }
            }
            const sanBox = san.getBoundingClientRect();
            const badgeBox = badge.getBoundingClientRect();
            if (
                Math.min(sanBox.right, badgeBox.right) - Math.max(sanBox.left, badgeBox.left) > 1 &&
                Math.min(sanBox.bottom, badgeBox.bottom) - Math.max(sanBox.top, badgeBox.top) > 1
            )
                offenders.push(`${san.textContent} SAN overlaps badge`);
            return {
                san: san.textContent,
                label: label.textContent,
                width: card.getBoundingClientRect().width,
                textWidths,
                labelWidth: label.clientWidth,
            };
        });
        return {
            fontSize: getComputedStyle(document.documentElement).fontSize,
            tileWidth: element.closest(".mosaic-tile")!.getBoundingClientRect().width,
            assignedWidth: bounds.right - bounds.left,
            gridWidth: grid.getBoundingClientRect().width,
            columns: getComputedStyle(grid).gridTemplateColumns,
            cards,
            offenders,
        };
    });
}

for (const scale of [100, 200]) {
    for (const viewport of [
        { name: "desktop", width: 1440, height: 900 },
        { name: "compact", width: 800, height: 720 },
        { name: "narrow", width: 320, height: 720 },
    ]) {
        test(`board-keyboard: tablebase ranks winning promotions before draws and losses and plays the winner ${viewport.name} ${scale}%`, async ({
            page,
            mockScenario,
            capture,
        }, testInfo) => {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            await page.addInitScript(
                (fontScale) => localStorage.setItem("font-size", String(fontScale)),
                scale,
            );
            const fen = "4k3/6KP/8/8/8/8/7p/8 w - - 0 1";
            // Fields consumed by the panel from the recorded Lichess /standard response for this FEN.
            // The parent wins, while winning moves have a child category of loss.
            await mockScenario({
                commands: {
                    get_public_lichess_json: {
                        result: JSON.stringify({
                            category: "win",
                            dtz: 1,
                            dtm: 17,
                            moves: [
                                { uci: "h7h8q", san: "h8=Q+", category: "loss", dtz: -2, dtm: -16 },
                                { uci: "h7h8r", san: "h8=R+", category: "loss", dtz: -2, dtm: -26 },
                                { uci: "g7g8", san: "Kg8", category: "draw", dtz: 0, dtm: 0 },
                                { uci: "g7f6", san: "Kf6", category: "win", dtz: 1, dtm: 19 },
                                { uci: "g7g6", san: "Kg6", category: "win", dtz: 1, dtm: 19 },
                                { uci: "g7h6", san: "Kh6", category: "win", dtz: 1, dtm: 19 },
                                // Exercise the provider's absent-DTM fallback alongside the recorded promotions.
                                { uci: "g7h8", san: "Kh8", category: "win", dtz: 1, dtm: null },
                                { uci: "h7h8n", san: "h8=N", category: "win", dtz: 1, dtm: 19 },
                                { uci: "h7h8b", san: "h8=B", category: "win", dtz: 1, dtm: 15 },
                            ],
                        }),
                    },
                },
            });
            const grid = await importAnalysisFen(page, fen);
            await page.getByRole("tab", { name: "Analysis", exact: true }).click();
            const tablebase = page.locator(".mantine-Accordion-item").filter({
                has: page.getByRole("button", { name: /^Tablebase/ }),
            });
            await tablebase.getByRole("button", { name: /^Tablebase/ }).click();
            const moveLabels = tablebase.locator(
                ".mantine-SimpleGrid-root > .mantine-Paper-root > .mantine-Group-root > .mantine-Text-root",
            );
            await expect(moveLabels).toHaveText([
                "h8=Q+",
                "h8=R+",
                "Kg8",
                "h8=B",
                "h8=N",
                "Kf6",
                "Kg6",
                "Kh6",
                "Kh8",
            ]);
            // Mantine removes overflow clipping when the accordion expansion finishes.
            const panel = tablebase.getByRole("region");
            await expect(panel).toHaveCSS("overflow", "visible");
            await expect(panel).toHaveCSS("opacity", "1");
            const cards = tablebase.locator(".mantine-SimpleGrid-root > .mantine-Paper-root");
            await expect(cards).toHaveCount(9);
            await expect(cards.locator(".mantine-Badge-label")).toHaveText([
                "DTM 16",
                "DTM 26",
                "Draw",
                "DTM 15",
                "DTM 19",
                "DTM 19",
                "DTM 19",
                "DTM 19",
                "DTZ 1",
            ]);
            await expect(page.locator("html")).toHaveCSS("font-size", `${(16 * scale) / 100}px`);
            async function assertFit(stage: string) {
                for (const card of await cards.all()) {
                    await card.scrollIntoViewIfNeeded();
                    await expect(card).toBeVisible();
                    // Vertical reflow uses the existing ScrollArea rather than requiring every row at once.
                    expect(
                        await card.evaluate((element) => {
                            const cardBox = element.getBoundingClientRect();
                            const scrollBox = element
                                .closest(".mantine-ScrollArea-viewport")!
                                .getBoundingClientRect();
                            return (
                                cardBox.top >= scrollBox.top - 1 &&
                                cardBox.bottom <= scrollBox.bottom + 1
                            );
                        }),
                    ).toBe(true);
                }
                await cards.first().scrollIntoViewIfNeeded();
                await capture(`board-tablebase-winning-moves-${stage}`);
                const geometry = await tablebaseGeometry(tablebase);
                console.log(
                    `TABLEBASE_GEOMETRY ${viewport.name} ${scale}% ${stage} ${JSON.stringify(geometry)}`,
                );
                await testInfo.attach(`geometry-${stage}`, {
                    body: JSON.stringify(geometry, null, 2),
                    contentType: "application/json",
                });
                expect(
                    geometry.offenders,
                    `tablebase content fit ${viewport.name} ${scale}% ${stage}`,
                ).toEqual([]);
                return geometry;
            }
            const initial = await assertFit("initial");
            if (viewport.name === "desktop") {
                // Widen first so 200% clears the panel minimum, then narrow at the same viewport size.
                const root = page.locator(".mosaic-root");
                const split = root.locator(".mosaic-split.-row");
                await dragMosaicDivider(page, {
                    root,
                    split,
                    direction: "row",
                    percentage: 15,
                    crossAxisRatio: 0.25,
                });
                const wide = await assertFit("wide-pane");
                await dragMosaicDivider(page, {
                    root,
                    split,
                    direction: "row",
                    percentage: 35,
                    crossAxisRatio: 0.25,
                });
                await expect
                    .poll(async () => (await tablebaseGeometry(tablebase)).assignedWidth)
                    .toBeLessThan(wide.assignedWidth - 50);
                const narrow = await assertFit("narrow-pane");
                expect(narrow.tileWidth).toBeLessThan(wide.tileWidth - 50);
                expect(wide.assignedWidth).toBeGreaterThan(initial.assignedWidth + 50);
                expect(wide.cards[0].width).not.toBe(narrow.cards[0].width);
                expect(page.viewportSize()).toEqual({ width: 1440, height: 900 });
            }
            await tablebase.getByText("h8=Q+", { exact: true }).click();
            for (const name of [
                "h8, White Queen",
                "h7, empty",
                "g7, White King",
                "e8, Black King",
                "h2, Black Pawn",
            ]) {
                await expect(grid.getByRole("gridcell", { name, exact: true })).toHaveCount(1);
            }
        });
    }
}

for (const { name, from, to, piece } of [
    { name: "ordinary move", from: "e1", to: "f1", piece: "White King" },
    { name: "en passant", from: "e5", to: "d6", piece: "White Pawn" },
]) {
    test(`board-keyboard: retired forced-ep preference permits ${name}`, async ({ page }) => {
        const grid = await importAnalysisFen(page, "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2");
        // Reproduce the legacy on-disk preference before a fresh renderer reads it.
        await page.evaluate(() => localStorage.setItem("forced-ep", "true"));
        await preserveStorageForReload(page);
        await expect(grid).toBeVisible();
        await playBoardMove(page, page.locator("cg-board").first(), from, to);
        await expect(
            grid.getByRole("gridcell", { name: `${to}, ${piece}`, exact: true }),
        ).toHaveCount(1);
        await expect(
            grid.getByRole("gridcell", { name: `${from}, empty`, exact: true }),
        ).toHaveCount(1);
        if (name === "en passant") {
            await expect(
                grid.getByRole("gridcell", { name: "d5, empty", exact: true }),
            ).toHaveCount(1);
        }
    });
}

test("board-keyboard: imported EP root reaches threefold through real moves and survives reload", async ({
    page,
    capture,
}) => {
    const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
    const grid = await importAnalysisFen(page, fen);
    const tab = (await activeWorkspaceTab(page))!;
    const board = page.locator("cg-board").first();
    const result = page.getByLabel(/^result$/i);
    await expect(result).toHaveValue("*");

    async function expectSavedCycle(cycle: number) {
        await expect
            .poll(async () => {
                const raw = await page.evaluate(
                    (key) => sessionStorage.getItem(key),
                    tab.treeKey ?? tab.value,
                );
                const state = raw
                    ? deserializeStorageValue<{ state: TreeState }>(raw)?.state
                    : null;
                if (!state) return null;
                let current = state.root;
                for (const index of state.position) current = current.children[index];
                return {
                    rootFen: state.root.fen,
                    headerFen: state.headers.fen,
                    result: state.headers.result,
                    position: state.position,
                    currentFen: current.fen,
                    halfMoves: current.halfMoves,
                };
            })
            .toEqual({
                rootFen: fen,
                headerFen: fen,
                result: cycle === 1 ? "*" : "1/2-1/2",
                position: Array(cycle * 4).fill(0),
                currentFen: fen.replace("e3 0 1", `- ${4 * cycle} ${2 * cycle + 1}`),
                halfMoves: 4 * cycle + 1,
            });
    }

    for (let cycle = 1; cycle <= 2; cycle++) {
        for (const [from, to] of [
            ["g8", "f6"],
            ["g1", "f3"],
            ["f6", "g8"],
            ["f3", "g1"],
        ]) {
            await playBoardMove(page, board, from, to);
        }
        await expect(result).toHaveValue(cycle === 1 ? "*" : "1/2-1/2");
        await expectSavedCycle(cycle);
        await preserveStorageForReload(page);
        await expect(grid).toBeVisible();
        await expect(result).toHaveValue(cycle === 1 ? "*" : "1/2-1/2");
        expect((await activeWorkspaceTab(page))!.value).toBe(tab.value);
        await expectSavedCycle(cycle);
    }
    await expect(grid.getByRole("gridcell", { name: "g8, Black Knight", exact: true })).toHaveCount(
        1,
    );
    await expect(grid.getByRole("gridcell", { name: "g1, White Knight", exact: true })).toHaveCount(
        1,
    );
    await capture("board-en-passant-repetition");
});

test("board-keyboard: editor castling rights follow a king dragged off its back rank", async ({
    page,
    capture,
}) => {
    const initialFen = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 17 23";
    const editedFen = "r3k2r/8/8/8/8/8/4K3/R6R w kq - 17 23";
    const grid = await importAnalysisFen(page, initialFen);
    await expect(grid.getByRole("gridcell", { name: "e1, White King", exact: true })).toHaveCount(
        1,
    );
    await expect(grid.getByRole("gridcell", { name: "e2, empty", exact: true })).toHaveCount(1);
    await chooseBoardMoreAction(page, /^Edit Position/);
    const fen = page.locator("#bottomRight").getByPlaceholder("Enter FEN", { exact: true });
    await expect(fen).toHaveValue(initialFen);

    // Edit mode uses Chessground's free drag movement rather than a played move.
    await dragBoard(page, page.locator("cg-board").first(), "e1", "e2", "left");
    await expect(grid.getByRole("gridcell", { name: "e2, White King", exact: true })).toHaveCount(
        1,
    );
    await expect(grid.getByRole("gridcell", { name: "e1, empty", exact: true })).toHaveCount(1);
    await expect(fen).toHaveValue(editedFen);
    await expectEditorRoot(page, editedFen);
    await capture("board-editor-castling");
});

for (const fixture of [
    { name: "white-outer", fen: "4k3/8/8/8/8/8/8/3K1R1R w K - 17 23", checkbox: 0 },
    { name: "white-inner", fen: "4k3/8/8/8/8/8/8/3K1R1R w F - 17 23", checkbox: 0 },
    { name: "black-outer", fen: "3k1r1r/8/8/8/8/8/8/4K3 b k - 17 23", checkbox: 1 },
    { name: "black-inner", fen: "3k1r1r/8/8/8/8/8/8/4K3 b f - 17 23", checkbox: 1 },
]) {
    test(`board-keyboard: editor castling preserves the existing ${fixture.name} rook right`, async ({
        page,
        capture,
    }) => {
        await importAnalysisFen(page, fixture.fen);
        await chooseBoardMoreAction(page, /^Edit Position/);
        const editor = page.locator("#bottomRight");
        await expect(editor.getByPlaceholder("Enter FEN", { exact: true })).toHaveValue(
            fixture.fen,
        );
        await expect(
            editor.getByRole("checkbox", { name: "O-O", exact: true }).nth(fixture.checkbox),
        ).toBeChecked();
        await expectEditorRoot(page, fixture.fen);
        await capture(`board-editor-castling-${fixture.name}`);
    });
}

test("board-keyboard: user marks coexist, toggle individually, persist per node and clear on left click", async ({
    page,
    capture,
}) => {
    await page.goto("/");
    await page.getByRole("button", { name: /^Analysis Board$/ }).click();
    const board = page.locator("cg-board").first();
    await playBoardMove(page, board, "e2", "e4");
    const start = page.getByRole("button", { name: "Go to start", exact: true });
    await start.click();
    const svg = page.locator(".cg-wrap svg.cg-shapes").first();
    const circles = svg.locator("g[cgHash] circle");
    const arrows = svg.locator("g[cgHash] line");
    await drawMark(page, board, "c4");
    await expect(circles).toHaveCount(1);
    await drawMark(page, board, "d4");
    await expect(circles).toHaveCount(2);
    const retainedCircle = await circles.last().getAttribute("cx");
    await drawMark(page, board, "c4");
    await expect(circles).toHaveCount(1);
    await expect(circles).toHaveAttribute("cx", retainedCircle!);
    await drawMark(page, board, "a3", "a5");
    await expect(arrows).toHaveCount(1);
    await drawMark(page, board, "b3", "b5");
    await expect(arrows).toHaveCount(2);
    const retainedArrow = await arrows.last().getAttribute("x1");
    await drawMark(page, board, "a3", "a5");
    await expect(arrows).toHaveCount(1);
    await expect(arrows).toHaveAttribute("x1", retainedArrow!);
    await expect(circles).toHaveCount(1);
    await capture("board-multiple-user-drawings");

    await page.getByRole("button", { name: "Next move", exact: true }).click();
    await expect(circles).toHaveCount(0);
    await expect(arrows).toHaveCount(0);
    await drawMark(page, board, "f5");
    await expect(circles).toHaveCount(1);
    await start.click();
    await expect(circles).toHaveCount(1);
    await expect(arrows).toHaveCount(1);
    await expect(circles).toHaveAttribute("cx", retainedCircle!);
    await preserveStorageForReload(page);
    await expect(circles).toHaveCount(1);
    await expect(arrows).toHaveCount(1);
    await drawMark(page, board, "d4");
    await expect(circles).toHaveCount(0);
    await expect(arrows).toHaveCount(1);
    await board.click();
    await expect(arrows).toHaveCount(0);
    await page.getByRole("button", { name: "Next move", exact: true }).click();
    await expect(circles).toHaveCount(1);
});

test("board-keyboard: explicit keep-drawings preference survives left clicks and still permits toggling", async ({
    page,
}) => {
    await page.addInitScript(() => localStorage.setItem("erase-drawables-on-click", "false"));
    await page.goto("/");
    await page.getByRole("button", { name: /^Analysis Board$/ }).click();
    const board = page.locator("cg-board").first();
    const circles = page.locator(".cg-wrap svg.cg-shapes g[cgHash] circle");
    await drawMark(page, board, "c4");
    await expect(circles).toHaveCount(1);
    await board.click();
    await expect(circles).toHaveCount(1);
    await drawMark(page, board, "c4");
    await expect(circles).toHaveCount(0);
});

test("board-keyboard: PGN imports render six named arrow and square colors despite bad neighbors", async ({
    page,
    mockScenario,
    capture,
}) => {
    const drawings =
        "[%cal Ra2a4,Gb2b4,Yc2c4,Bd2d4,Oe2e4,Cf2f4,Xg2g4,Ra9a2,broken] " +
        "[%csl Ra5,Gb5,Yc5,Bd5,Oe5,Cf5,Qh8,Cz9]";
    const pgn = `[Event "Six colors"]\n[Result "*"]\n\n{${drawings}} 1. e4 *`;
    await mockScenario({
        commands: filesWorkspaceCommands([[filesWorkspaceFixture.pgnFile]], {
            ...pgnFileCommands,
            read_games: {
                result: [
                    { pgn, stamp: "e".repeat(64), revision: "e2e-pgn-revision", present: true },
                ],
            },
            read_game: {
                result: { pgn, stamp: "e".repeat(64), revision: "e2e-pgn-revision", present: true },
            },
            // Mock only native lexing. The real parsePGN and Chessground render the imported data.
            lex_pgn: {
                result: [
                    { type: "Header", value: { tag: "Event", value: "Six colors" } },
                    { type: "Header", value: { tag: "Result", value: "*" } },
                    { type: "Comment", value: drawings },
                    { type: "San", value: "e4" },
                    { type: "Outcome", value: "*" },
                ],
            },
        }),
    });
    await page.goto("/library");
    await page.getByRole("button", { name: /choose folder/i }).click();
    await selectFilesTreeRow(page, filesWorkspaceFixture.pgnFile.name);
    await page.getByRole("button", { name: "Open game", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.getByRole("button", { name: "Go to start", exact: true }).click();
    const board = page.locator(".cg-wrap");
    await expect(board).toBeVisible();
    const svg = board.locator("svg.cg-shapes");
    await expect(svg.locator("g[cgHash] line")).toHaveCount(6);
    await expect(svg.locator("g[cgHash] circle")).toHaveCount(6);
    const colors = {
        red: "#882020",
        green: "#15781B",
        yellow: "#e8c500",
        blue: "#003088",
        orange: "#ff6600",
        cyan: "#00bcd4",
    };
    const strokes: string[] = [];
    for (const [name, color] of Object.entries(colors)) {
        const arrow = svg.locator(`g[cgHash*=',${name}'] line`);
        const square = svg.locator(`g[cgHash*=',${name}'] circle`);
        await expect(arrow).toHaveCount(1);
        await expect(square).toHaveCount(1);
        await expect(arrow).toHaveAttribute("stroke", color);
        await expect(square).toHaveAttribute("stroke", color);
        strokes.push((await arrow.getAttribute("stroke"))!);
    }
    expect(new Set(strokes).size).toBe(6);
    await page.mouse.move(0, 0);
    await capture("board-six-color-pgn-drawings");
    await drawMark(page, board.locator("cg-board"), "b5");
    await expect(svg.locator("g[cgHash] circle")).toHaveCount(5);
    await expect(svg.locator("g[cgHash*=',green'] circle")).toHaveCount(0);
    await expect(svg.locator("g[cgHash] line")).toHaveCount(6);
    await drawMark(page, board.locator("cg-board"), "b2", "b4");
    await expect(svg.locator("g[cgHash] line")).toHaveCount(5);
    await expect(svg.locator("g[cgHash*=',green'] line")).toHaveCount(0);
    await expect(svg.locator("g[cgHash] circle")).toHaveCount(5);
});

test("board-keyboard: refuses an excess-material engine game with its localized position message", async ({
    page,
    mockScenario,
}) => {
    const fen = "4k3/8/8/8/8/8/PPPPPPPP/QQQ1K3 w - - 0 1";
    await page.addInitScript(() => {
        localStorage.setItem(
            "engines",
            JSON.stringify([
                {
                    type: "local",
                    id: "e2e-engine",
                    name: "Stockfish 19",
                    version: "19",
                    filename: "stockfish",
                    handle: { id: { id: "e2e-engine-handle" }, kind: "engine" },
                    settings: [],
                    go: { t: "Depth", c: 1 },
                },
            ]),
        );
    });
    await mockScenario({
        commands: {
            start_game: {
                error: {
                    tag: "backend-error",
                    category: "engine-position-rejected",
                    message: "Position cannot be played against an engine",
                } satisfies ErrorPayload,
            },
        },
    });
    await importAnalysisFen(page, fen);
    await page.getByRole("button", { name: "Play from here", exact: true }).click();
    await page.getByText("Engine", { exact: true }).last().click();
    await expect(page.locator("input[value='Stockfish 19']")).toBeVisible();
    const start = page.getByRole("button", { name: "Start game", exact: true });
    await start.click();
    await expect(page.getByRole("alert")).toHaveText(
        "This position cannot be played against an engine.",
    );
    await expect(page.getByRole("alert")).not.toContainText("Unable to start the game.");
    await expect(start).toBeEnabled();
    const invocations = await page.evaluate(() =>
        window.__E2E_TAURI__.invocations().filter(({ command }) => command === "start_game"),
    );
    expect(invocations).toHaveLength(1);
    expect(invocations[0].args).toMatchObject({
        config: { initialFen: fen, black: { type: "engine", engineId: "e2e-engine" } },
    });
});

test("board-keyboard: opens analysis and exposes a keyboard-operable board", async ({
    page,
    assertAccessible,
    assertNoHorizontalOverflow,
    capture,
}) => {
    // Keep this keyboard/layout baseline on its original explicit preference.
    await page.addInitScript(() => localStorage.setItem("erase-drawables-on-click", "false"));
    await page.goto("/");

    await page.getByRole("button", { name: /^Analysis Board$/ }).click();
    const whiteBoard = page.getByRole("grid", {
        name: "Chessboard, White orientation",
        exact: true,
    });
    const blackBoard = page.getByRole("grid", {
        name: "Chessboard, Black orientation",
        exact: true,
    });
    await expect(whiteBoard).toBeVisible();
    await expect(whiteBoard).toHaveAttribute("aria-activedescendant", "board-square-e2");
    for (const [square, piece] of [
        ["a1", "White Rook"],
        ["b1", "White Knight"],
        ["c1", "White Bishop"],
        ["d1", "White Queen"],
        ["e1", "White King"],
        ["f2", "White Pawn"],
        ["a8", "Black Rook"],
        ["b8", "Black Knight"],
        ["c8", "Black Bishop"],
        ["d8", "Black Queen"],
        ["e8", "Black King"],
        ["f7", "Black Pawn"],
    ] as const) {
        await expect(
            page.getByRole("gridcell", {
                name: `${square}, ${piece}`,
                exact: true,
            }),
        ).toHaveCount(1);
    }
    await expect(
        page.getByRole("gridcell", { name: "e2, White Pawn", exact: true }),
    ).toHaveAttribute("aria-selected", "false");
    await expect(page.getByRole("gridcell", { name: "e4, empty", exact: true })).toHaveCount(1);
    await expect(page.getByLabel(/^result$/i)).toBeVisible();
    await whiteBoard.focus();
    await expect(whiteBoard).toBeFocused();

    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await expect(
        page.getByRole("gridcell", {
            name: "f2, White Pawn, move source selected",
            exact: true,
        }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText(/selected|illegal move/i)).toBeVisible();
    await assertNoHorizontalOverflow();
    await assertAccessible();
    await capture("board-keyboard");
    await expect(page).toHaveScreenshot("board-keyboard.png", { fullPage: true });
    await page.keyboard.press("f");
    await expect(blackBoard).toBeVisible();
    await expect(blackBoard.getByRole("gridcell").first()).toHaveAttribute("id", "board-square-h1");
    await expect(blackBoard.getByRole("gridcell").last()).toHaveAttribute("id", "board-square-a8");
    await expect(
        page.getByRole("gridcell", {
            name: "f2, White Pawn, move source selected",
            exact: true,
        }),
    ).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("f");
    await expect(whiteBoard).toBeVisible();
    // The focus ring paints outside the grid's box, where box-based clip checks cannot see it.
    // Mosaic (800px) and both stacked widths put the grid's right edge on the wrapper's clip.
    const ringClips = () =>
        whiteBoard.evaluate((grid) => {
            if (!grid.matches(":focus-visible")) return ["grid has no visible focus"];
            const style = getComputedStyle(grid);
            if (style.outlineStyle === "none" || parseFloat(style.outlineWidth) <= 0)
                return ["grid has no painted focus ring"];
            const extent = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
            const box = grid.getBoundingClientRect();
            const ring = {
                left: box.left - extent,
                right: box.right + extent,
                top: box.top - extent,
                bottom: box.bottom + extent,
            };
            const cut: string[] = [];
            for (
                let node = grid.parentElement;
                node && node !== document.body;
                node = node.parentElement
            ) {
                const clip = getComputedStyle(node);
                const own = node.getBoundingClientRect();
                const inner = {
                    left: own.left + node.clientLeft,
                    right: own.left + node.clientLeft + node.clientWidth,
                    top: own.top + node.clientTop,
                    bottom: own.top + node.clientTop + node.clientHeight,
                };
                if (
                    clip.overflowX !== "visible" &&
                    (ring.left < inner.left - 0.5 || ring.right > inner.right + 0.5)
                )
                    cut.push(
                        `x ${ring.left.toFixed(1)}..${ring.right.toFixed(1)} outside ${inner.left.toFixed(1)}..${inner.right.toFixed(1)}`,
                    );
                if (
                    clip.overflowY !== "visible" &&
                    (ring.top < inner.top - 0.5 || ring.bottom > inner.bottom + 0.5)
                )
                    cut.push(
                        `y ${ring.top.toFixed(1)}..${ring.bottom.toFixed(1)} outside ${inner.top.toFixed(1)}..${inner.bottom.toFixed(1)}`,
                    );
            }
            return cut;
        });
    for (const [width, layout] of [
        [800, "mosaic"],
        [320, "stacked"],
        [500, "stacked"],
    ] as const) {
        await page.setViewportSize({ width, height: 720 });
        await expect(page.locator(`[data-board-layout="${layout}"]`)).toHaveCount(1);
        // Crossing into the stacked layout remounts the board; keyboard modality keeps the ring.
        await whiteBoard.focus();
        await expect.poll(ringClips, { message: `focus ring clipped at ${width}px` }).toEqual([]);
    }
    await page.setViewportSize({ width: 800, height: 720 });
    // Collapsing the evaluation bar leaves a 16px button that clips an icon larger than itself.
    await page.keyboard.press("z");
    const showEvaluation = page.getByRole("button", { name: "Show evaluation", exact: true });
    // Moving the board from the stacked layout into its Mosaic tile shrinks its wrap from 706px to
    // 313px. Wait for that move to commit, else the stacked board already counts as settled, then
    // for chessground to re-size its container.
    await expect(page.locator('[data-board-layout="mosaic"]')).toHaveCount(1);
    await expect(showEvaluation).toBeVisible();
    await waitForBoardSizeSettled(page);
    await assertNothingClipped(showEvaluation, { mode: "reachable" });
    // The stacked layout's open bar is 8px wide; the collapsed column widens to hold the button.
    await page.setViewportSize({ width: 500, height: 720 });
    // The layout switch is observer-driven: until it commits, the page is the Mosaic layout at
    // 500px, whose narrower tile shrinks the wrap again. Measure the stacked layout, settled.
    await expect(page.locator('[data-board-layout="stacked"]')).toHaveCount(1);
    await expect(showEvaluation).toBeVisible();
    await waitForBoardSizeSettled(page);
    await assertNothingClipped(showEvaluation, { mode: "reachable" });
    await showEvaluation.click();
    await expect(showEvaluation).toHaveCount(0);
});

test.describe("board-keyboard: German game command errors", () => {
    test.use({ appLocale: "de-DE" });

    test("localizes a rejected game start and keeps retry enabled", async ({
        page,
        mockScenario,
        capture,
    }) => {
        const diagnostic = "private native game-start diagnostic at /private/engine.bin";
        const rejection = {
            tag: "backend-error",
            category: "engine-timeout",
            message: diagnostic,
        } as const satisfies ErrorPayload;

        await mockScenario({ commands: { start_game: { error: rejection } } });
        await page.goto("/");

        await page.getByRole("button", { name: "Spielen", exact: true }).click();
        const startButton = page.getByRole("button", { name: "Beginne Partie", exact: true });
        await expect(startButton).toBeVisible();

        const alert = page.getByRole("alert");
        await startButton.click();
        await expect(alert).toContainText(/Partie konnte nicht gestartet werden/);
        await expect(alert).not.toContainText(diagnostic);
        await expect(page.locator("body")).not.toContainText("/private/engine.bin");
        await expect(page.locator("body")).not.toContainText("Unable to start the game.");
        await expect(startButton).toBeEnabled();

        await startButton.click();
        await expect(alert).toContainText(/Partie konnte nicht gestartet werden/);
        await expect(startButton).toBeEnabled();

        const startInvocations = await page.evaluate(() =>
            window.__E2E_TAURI__.invocations().filter(({ command }) => command === "start_game"),
        );
        expect(startInvocations).toHaveLength(2);

        const logs = await page.evaluate(() =>
            window.__E2E_TAURI__
                .invocations()
                .filter(({ command }) => command === "plugin:log|log"),
        );
        expect(JSON.stringify(logs)).toContain("private native game-start diagnostic at [path]");
        expect(JSON.stringify(logs)).not.toContain("/private/engine.bin");

        await capture("board-game-command-error");
    });
});

test("board-keyboard: next move at a branch asks which continuation to play", async ({
    page,
    assertAccessible,
    assertNoHorizontalOverflow,
    capture,
}) => {
    // The default drawing behavior has its own interaction test and capture above.
    await page.addInitScript(() => localStorage.setItem("erase-drawables-on-click", "false"));
    await page.goto("/");
    await page.getByRole("button", { name: /^Analysis Board$/ }).click();
    const board = page.locator("cg-board").first();
    await expect(board).toBeVisible();

    // Chessground moves by click-click; squares are located from the board box (White at the bottom).
    const previous = page.getByRole("button", { name: "Previous move", exact: true });
    // 1.e4 (1.d4) (1.c4): the first move played is the main line, the others become variations.
    for (const [from, to] of [
        ["e2", "e4"],
        ["d2", "d4"],
        ["c2", "c4"],
    ]) {
        await playBoardMove(page, board, from, to);
        await expect(page.getByRole("gridcell", { name: `${to}, White Pawn` })).toHaveCount(1);
        await previous.click();
    }
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    // Off the controls, so no tooltip from the last click sits under the list in the screenshot.
    await page.mouse.move(250, 600);

    await page.keyboard.press("ArrowRight");
    const chooser = page.getByRole("listbox", { name: "Choose a continuation" });
    await expect(chooser).toBeVisible();
    await expect(chooser.getByRole("option")).toHaveText(["1. e4", "1. d4", "1. c4"]);
    await expect(chooser.getByRole("option", { selected: true })).toHaveText("1. e4");
    await expect(page.getByRole("gridcell", { name: "e2, White Pawn" })).toHaveCount(1);
    await assertChooserInsideBoard(board, chooser);
    await assertNoHorizontalOverflow();
    await assertAccessible();
    await capture("variation-chooser");
    await expect.soft(page).toHaveScreenshot("variation-chooser.png", { fullPage: true });

    await page.keyboard.press("ArrowDown");
    await expect(chooser.getByRole("option", { selected: true })).toHaveText("1. d4");
    await page.keyboard.press("ArrowRight");
    await expect(chooser).toBeHidden();
    await expect(page.getByRole("gridcell", { name: "d4, White Pawn" })).toHaveCount(1);
    await expect(page.getByRole("gridcell", { name: "e2, White Pawn" })).toHaveCount(1);

    const start = page.getByRole("button", { name: "Go to start", exact: true });
    await start.click();
    await goToSettings(page);
    await page.getByRole("tab", { name: "Analysis & notation", exact: true }).click();
    const chooseVariations = page.getByRole("switch", {
        name: "Choose Variations at Branches",
        exact: true,
    });
    await expect(chooseVariations).toBeChecked();
    await chooseVariations.uncheck();
    await expect(chooseVariations).not.toBeChecked();

    await preserveStorageForReload(page);
    await page.getByRole("tab", { name: "Analysis & notation", exact: true }).click();
    await expect(chooseVariations).not.toBeChecked();
    await goToBoards(page);
    await expect(board).toBeVisible();
    await start.click();
    await expect(page.getByRole("gridcell", { name: "e2, White Pawn" })).toHaveCount(1);
    await expect(page.getByRole("gridcell", { name: "d2, White Pawn" })).toHaveCount(1);
    await expect(page.getByRole("gridcell", { name: "c2, White Pawn" })).toHaveCount(1);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.mouse.move(250, 600);
    await page.keyboard.press("ArrowRight");
    await expect(chooser).toHaveCount(0);
    await expect(page.getByRole("gridcell", { name: "e4, White Pawn" })).toHaveCount(1);
});

test("board-keyboard: overflowing chooser stays bounded and reaches lower continuations", async ({
    page,
    assertAccessible,
}) => {
    await page.goto("/");
    await page.getByRole("button", { name: /^Analysis Board$/ }).click();
    const board = page.locator("cg-board").first();
    const previous = page.getByRole("button", { name: "Previous move", exact: true });
    const moves = [
        ["a2", "a3"],
        ["a2", "a4"],
        ["b2", "b3"],
        ["b2", "b4"],
        ["c2", "c3"],
        ["c2", "c4"],
        ["d2", "d3"],
        ["d2", "d4"],
        ["e2", "e3"],
        ["e2", "e4"],
        ["f2", "f3"],
        ["f2", "f4"],
        ["g2", "g3"],
        ["g2", "g4"],
        ["h2", "h3"],
        ["h2", "h4"],
        ["b1", "a3"],
        ["b1", "c3"],
        ["g1", "f3"],
        ["g1", "h3"],
    ];
    for (const [from, to] of moves) {
        await playBoardMove(page, board, from, to);
        await previous.click();
    }
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.mouse.move(250, 600);
    await page.keyboard.press("ArrowRight");
    const chooser = page.getByRole("listbox", { name: "Choose a continuation" });
    await expect(chooser.getByRole("option")).toHaveCount(moves.length);
    await assertChooserInsideBoard(board, chooser);
    expect(await chooser.evaluate((list) => list.scrollHeight > list.clientHeight)).toBe(true);
    await page.keyboard.press("ArrowUp");
    const last = chooser.getByRole("option", { selected: true });
    await expect(last).toHaveText("1. Nh3");
    await expect
        .poll(async () => {
            const listBox = (await chooser.boundingBox())!;
            const rowBox = (await last.boundingBox())!;
            return (
                rowBox.y >= listBox.y - 1 &&
                rowBox.y + rowBox.height <= listBox.y + listBox.height + 1
            );
        })
        .toBe(true);
    await assertChooserInsideBoard(board, chooser);
    await assertAccessible();
    await chooser.getByRole("option", { name: "1. Nf3", exact: true }).click();
    await expect(chooser).toBeHidden();
    await expect(page.getByRole("gridcell", { name: "f3, White Knight", exact: true })).toHaveCount(
        1,
    );
});

test("board-keyboard: analysis board puts actions in top bar, removes left column, and uses Notation frame with View menu", async ({
    page,
}) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: /^Analysis Board$/ }).click();

    const topBar = page.locator('[data-board-bar="above"]');
    const notation = page.locator("#bottomRight");
    const notationHeader = notation.locator('[data-panel-header="bottomRight"]');
    const whiteBoard = page.getByRole("grid", {
        name: "Chessboard, White orientation",
        exact: true,
    });
    const blackBoard = page.getByRole("grid", {
        name: "Chessboard, Black orientation",
        exact: true,
    });
    await expect(whiteBoard).toBeVisible();

    // Top bar holds Play from here, Flip Board, and More actions.
    await expect(topBar.getByRole("button", { name: "Play from here", exact: true })).toBeVisible();
    const flipButton = topBar.getByRole("button", { name: /^Flip Board/ });
    await expect(flipButton).toBeVisible();
    const moreButton = topBar.getByRole("button", { name: "More actions", exact: true });
    await expect(moreButton).toBeVisible();

    // Removed left-column buttons and top-level moved actions are absent.
    for (const label of [
        "Undo",
        "Redo",
        "Clear Drawings",
        "Take back",
        "Edit Position",
        "Take Snapshot",
        "Save a copy…",
    ]) {
        await expect(page.getByRole("button", { name: label, exact: true })).toHaveCount(0);
    }

    // Notation uses the shared PanelHeader frame with title "Notation", grip, no close button,
    // and no left toolbar column beside the move list.
    await expect(notationHeader).toBeVisible();
    await expect(notationHeader).toContainText("Notation");
    await expect(notationHeader.locator('[data-arrange-grip="bottomRight"]')).toBeVisible();
    await expect(notationHeader.getByRole("button", { name: /Return to the tabs/ })).toHaveCount(0);
    const headerBox = (await notationHeader.boundingBox())!;
    const rowsBox = (await notation.locator("[data-notation-rows]").boundingBox())!;
    expect(Math.abs(rowsBox.x - headerBox.x)).toBeLessThanOrEqual(2);

    // Flip in the top bar flips the board.
    await flipButton.click();
    await expect(blackBoard).toBeVisible();
    await flipButton.click();
    await expect(whiteBoard).toBeVisible();

    // Add a variation and a comment, then toggle both through the View menu without it closing.
    const board = page.locator("cg-board").first();
    await playBoardMove(page, board, "e2", "e4");
    await page.getByRole("button", { name: "Previous move", exact: true }).click();
    await playBoardMove(page, board, "d2", "d4");
    await page.getByRole("tab", { name: "Annotate", exact: true }).click();
    await page.locator('[contenteditable="true"]').fill("Queen pawn alternative");
    await expect(notation.getByText("Queen pawn alternative")).toBeVisible();
    await expect(notation.getByRole("button", { name: "d4", exact: true })).toBeVisible();

    await notation.getByRole("button", { name: "View options", exact: true }).click();
    const viewMenu = page.getByRole("menu");
    await expect(viewMenu).toBeVisible();
    const showComments = viewMenu.getByRole("menuitem", {
        name: "Show comments",
        exact: true,
    });
    const showVariations = viewMenu.getByRole("menuitem", {
        name: "Show variations",
        exact: true,
    });
    await expect(showComments).toHaveAttribute("aria-checked", "true");
    await expect(showVariations).toHaveAttribute("aria-checked", "true");

    await showComments.click();
    await expect(viewMenu).toBeVisible();
    await expect(showComments).toHaveAttribute("aria-checked", "false");
    await expect(notation.getByText("Queen pawn alternative")).toHaveCount(0);

    await showVariations.click();
    await expect(viewMenu).toBeVisible();
    await expect(showVariations).toHaveAttribute("aria-checked", "false");
    await expect(notation.getByRole("button", { name: "d4", exact: true })).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(viewMenu).toHaveCount(0);

    // More -> Edit Position opens the position editor.
    await chooseBoardMoreAction(page, /^Edit Position/);
    await expect(notation.getByPlaceholder("Enter FEN", { exact: true })).toBeVisible();
    await expect(
        notation.getByRole("button", { name: "Close position editor", exact: true }),
    ).toBeVisible();
});

test("board-keyboard: game screen top bar actions and Edit position only while setting up", async ({
    page,
    mockScenario,
}) => {
    const liveState = createLiveGameState({ blackPlayer: "Human" });
    await mockScenario({
        commands: {
            start_game: { gameState: liveState },
            get_game_state: { gameState: liveState },
        },
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.getByRole("button", { name: "Start game", exact: true })).toBeVisible();

    const topBar = page.locator('[data-board-bar="above"]');
    await expect(topBar.getByRole("button", { name: "Take back", exact: true })).toHaveCount(0);
    await expect(topBar.getByRole("button", { name: "Analyze game", exact: true })).toBeVisible();
    await expect(topBar.getByRole("button", { name: /^Flip Board/ })).toBeVisible();
    const moreButton = topBar.getByRole("button", { name: "More actions", exact: true });
    await expect(moreButton).toBeVisible();

    // While setting up, More offers both Take Snapshot and Edit Position.
    await moreButton.click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: /^Take Snapshot/ })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /^Edit Position/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    // Once the game starts, top bar adds Take back and More drops Edit Position.
    await page.getByRole("button", { name: "Start game", exact: true }).click();
    await expect(page.getByRole("button", { name: "Resign", exact: true })).toBeVisible();
    await expect(topBar.getByRole("button", { name: "Take back", exact: true })).toBeVisible();
    await expect(topBar.getByRole("button", { name: "Analyze game", exact: true })).toBeVisible();
    await expect(topBar.getByRole("button", { name: /^Flip Board/ })).toBeVisible();
    await expect(moreButton).toBeVisible();

    await moreButton.click();
    await expect(menu.getByRole("menuitem", { name: /^Take Snapshot/ })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /^Edit Position/ })).toHaveCount(0);
});

async function assertNarrowTopBar(page: Page, playerName: string, expectedActionCount: number) {
    await waitForFontsSettled(page);
    const topBar = page.locator('[data-board-bar="above"]');
    const actions = topBar.locator('[data-no-drag="true"] button');
    await expect(actions).toHaveCount(expectedActionCount);

    const metrics = await topBar.evaluate((bar, expectedName) => {
        const barRect = bar.getBoundingClientRect();
        const rightGroupRect = bar.lastElementChild!.getBoundingClientRect();
        const nameEl = [...bar.querySelectorAll("p")].find((p) => p.textContent === expectedName);
        if (!nameEl) throw new Error(`missing player name ${expectedName}`);
        const nameRect = nameEl.getBoundingClientRect();
        const actionRects = [...bar.querySelectorAll('[data-no-drag="true"] button')].map((btn) =>
            btn.getBoundingClientRect(),
        );
        return {
            scrollWidth: bar.scrollWidth,
            clientWidth: bar.clientWidth,
            barRect: {
                left: barRect.left,
                right: barRect.right,
                top: barRect.top,
                bottom: barRect.bottom,
            },
            rightGroupLeft: rightGroupRect.left,
            name: {
                scrollWidth: nameEl.scrollWidth,
                clientWidth: nameEl.clientWidth,
                textOverflow: getComputedStyle(nameEl).textOverflow,
                right: nameRect.right,
                left: nameRect.left,
            },
            actions: actionRects.map((rect) => ({
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom,
            })),
        };
    }, playerName);

    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
    expect(metrics.name.scrollWidth).toBeGreaterThan(metrics.name.clientWidth);
    expect(metrics.name.textOverflow).toBe("ellipsis");
    expect(metrics.name.left).toBeGreaterThanOrEqual(metrics.barRect.left - 0.5);
    expect(metrics.name.right).toBeLessThanOrEqual(metrics.rightGroupLeft + 0.5);

    const firstTop = metrics.actions[0].top;
    for (const action of metrics.actions) {
        expect(Math.abs(action.top - firstTop)).toBeLessThanOrEqual(1);
        expect(action.left).toBeGreaterThanOrEqual(metrics.barRect.left - 0.5);
        expect(action.right).toBeLessThanOrEqual(metrics.barRect.right + 0.5);
        expect(action.top).toBeGreaterThanOrEqual(metrics.barRect.top - 0.5);
        expect(action.bottom).toBeLessThanOrEqual(metrics.barRect.bottom + 0.5);
    }
}

test("board-keyboard: narrow 1024x700 top bar truncates long player name and keeps actions on one row", async ({
    page,
    mockScenario,
}) => {
    const longTopName = "Grandmaster VeryLongOpponentNameForNarrowBoardBarTruncationVerification";
    const longBottomName = "Candidate Master LongBottomPlayerName";
    const startedState = createLiveGameState({
        whitePlayer: longBottomName,
        blackPlayer: longTopName,
        whiteTime: 180_000,
        blackTime: 180_000,
    });
    const imbalancedHeaders = {
        Event: "E2E",
        Site: "?",
        Date: "????.??.??",
        Round: "?",
        White: longBottomName,
        Black: longTopName,
        Result: "*",
        SetUp: "1",
        FEN: "rnbqkbnr/1ppppppp/8/8/8/8/2PPPPPP/RNBQKBNR w KQkq - 0 1",
    };

    await page.addInitScript(() => localStorage.setItem("auto-save", "false"));
    await page.setViewportSize({ width: 1024, height: 700 });
    await mockScenario({
        commands: filesWorkspaceCommands([[filesWorkspaceFixture.pgnFile]], {
            ...pgnFileCommands,
            lex_pgn: {
                result: [
                    ...Object.entries(imbalancedHeaders).map(([tag, value]) => ({
                        type: "Header",
                        value: { tag, value },
                    })),
                    { type: "Outcome", value: "*" },
                ],
            },
            start_game: { gameState: startedState },
            get_game_state: { gameState: startedState },
        }),
    });

    // Analysis board: long player name + material (+1) + Play from here / Flip / Save PGN / More.
    await page.goto("/library");
    await page.getByRole("button", { name: /choose folder/i }).click();
    await selectFilesTreeRow(page, filesWorkspaceFixture.pgnFile.name);
    await page.getByRole("button", { name: "Open game", exact: true }).click();
    await expect(page.getByRole("grid")).toBeVisible();
    await playBoardMove(page, page.locator("cg-board").first(), "e2", "e4");
    const topBar = page.locator('[data-board-bar="above"]');
    await expect(topBar.getByText("+1", { exact: true })).toBeVisible();
    await expect(topBar.getByRole("button", { name: /^Save PGN/ })).toBeVisible();
    await assertNarrowTopBar(page, longTopName, 4);

    // Game screen: started game with long player names + clock (03:00) + Take back / Analyze / Flip / More.
    await page.goto("/");
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.getByRole("button", { name: "Start game", exact: true }).click();
    await expect(page.getByRole("button", { name: "Resign", exact: true })).toBeVisible();
    await expect(topBar.getByText("03:00", { exact: true })).toBeVisible();
    await assertNarrowTopBar(page, longTopName, 4);
});
