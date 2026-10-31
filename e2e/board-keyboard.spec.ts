import {
    activeWorkspaceTab,
    assertChooserInsideBoard,
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
} from "./fixtures";
import type { ErrorPayload } from "../src/bindings/generated";
import { deserializeStorageValue } from "../src/state/store/debouncedStorage";
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
        await page.getByRole("button", { name: /choose collection/i }).click();
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
            await page.evaluate(() => document.fonts.ready);
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
                        bar: rect(bar),
                        name: rect(bar.querySelector("button")!),
                        indicators: Array.from(
                            bar.lastElementChild!.querySelectorAll("svg, p"),
                        ).map((el) => ({
                            tag: el.tagName,
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
            expect(geometry.board.width).toBe(720);
            expect(geometry.board.height).toBe(720);
            const indicators = geometry.bars.flatMap((bar) => bar.indicators);
            expect(indicators.filter((indicator) => indicator.tag === "svg")).toHaveLength(
                mode === "all" ? 3 : 1,
            );
            expect(indicators.filter((indicator) => indicator.text === "+1")).toHaveLength(1);
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
                    if (indicator.tag === "svg") expect(indicator.box.bottom).toBe(bar.name.bottom);
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
    await page.getByRole("button", { name: "Edit Position", exact: true }).click();
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
        await page.getByRole("button", { name: "Edit Position", exact: true }).click();
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
    await page.getByRole("button", { name: /^open$/i }).click();
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
    await page.getByRole("button", { name: /^open$/i }).click();
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
    await page.getByRole("button", { name: /choose collection/i }).click();
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
        yellow: "#e68f00",
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

    await page.getByRole("button", { name: /^open$/i }).click();
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
    ).toHaveAttribute("aria-selected", "true");
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
    await page.getByRole("button", { name: /^open$/i }).click();
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
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Board", exact: true }).click();
    const chooseVariations = page.getByRole("switch", {
        name: "Choose Variations at Branches",
        exact: true,
    });
    await expect(chooseVariations).toBeChecked();
    await chooseVariations.uncheck();
    await expect(chooseVariations).not.toBeChecked();

    await preserveStorageForReload(page);
    await expect(chooseVariations).not.toBeChecked();
    await page.getByRole("link", { name: "Board", exact: true }).click();
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
    await page.getByRole("button", { name: /^open$/i }).click();
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
