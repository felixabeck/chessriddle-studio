import {
    expect,
    test,
    filesWorkspaceCommands,
    filesWorkspaceFixture,
    pgnFileCommands,
    selectFilesTreeRow,
    whitePawnSquares,
    playBoardMove,
    type MockScenario,
} from "./fixtures";
import type { Page } from "@playwright/test";
import type { BestMovesPayload, ErrorPayload } from "../src/bindings/generated";

async function setupNotationMenu(
    page: Page,
    mockScenario: (scenario: MockScenario) => Promise<void>,
    scope: "workspace" | "preview",
    tableLayout: boolean,
) {
    await mockScenario({
        commands: filesWorkspaceCommands([[filesWorkspaceFixture.pgnFile]], {
            ...pgnFileCommands,
            write_game: { result: { stamp: "e".repeat(64), revision: "e2e-pgn-revision" } },
            lex_pgn: {
                result: [
                    { type: "San", value: "e4" },
                    { type: "San", value: "e5" },
                    { type: "ParenOpen" },
                    { type: "San", value: "c5" },
                    { type: "San", value: "Nf3" },
                    { type: "San", value: "d6" },
                    { type: "ParenClose" },
                    { type: "San", value: "Bc4" },
                    { type: "San", value: "Nc6" },
                    { type: "Outcome", value: "*" },
                ],
            },
        }),
    });
    await page.addInitScript((tableLayout) => {
        localStorage.setItem("table-view", JSON.stringify(tableLayout));
        localStorage.setItem("letters", JSON.stringify("letters"));
    }, tableLayout);
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose collection", exact: true }).click();
    await selectFilesTreeRow(page, filesWorkspaceFixture.pgnFile.name);
    if (scope === "workspace") {
        await page.getByRole("button", { name: "Open game", exact: true }).click();
        // The router URL can update before the outgoing preview unmounts.
        await expect(page.getByRole("tab", { name: "Info", exact: true })).toBeVisible();
    }
    const notation = page.locator(".mantine-ScrollArea-viewport").filter({
        has: page.getByRole("button", { name: "e4", exact: true }),
    });
    await expect(notation).toHaveCount(1);
    await expect(
        notation.locator("td").filter({
            has: page.getByRole("button", { name: "e5", exact: true }),
        }),
    ).toHaveCount(tableLayout ? 1 : 0);
    await expect(notation.getByRole("button", { name: "d6", exact: true })).toBeVisible();
    return notation;
}

for (const scope of ["workspace", "preview"] as const) {
    for (const tableLayout of [false, true]) {
        const layout = tableLayout ? "table" : "inline";
        test(`notation-delete: ${scope} ${layout} pointer action removes the targeted subtree`, async ({
            page,
            mockScenario,
            capture,
        }, testInfo) => {
            const notation = await setupNotationMenu(page, mockScenario, scope, tableLayout);
            const move = (name: string) => notation.getByRole("button", { name, exact: true });
            // Select a descendant, then right-click its ancestor without navigating to it.
            await move("Nc6").click();
            await expect(notation.locator('[data-notation-current="true"] button')).toHaveText(
                "Nc6",
            );
            await move("e5").click({ button: "right" });
            await expect(notation.locator('[data-notation-current="true"] button')).toHaveText(
                "Nc6",
            );
            const menu = page.getByRole("menu");
            const deleteMove = menu.getByRole("menuitem", { name: "Delete Move", exact: true });
            await expect(deleteMove).toBeVisible();
            await capture(`notation-delete-${scope}-${layout}-menu`);
            const bounds = (await deleteMove.boundingBox())!;
            await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
            await page.mouse.down();
            const mountedAfterMouseDown = await menu.count();
            await testInfo.attach("menu-pointer-lifetime", {
                body: JSON.stringify({ mountedAfterMouseDown }),
                contentType: "application/json",
            });
            await page.mouse.up();
            await expect(move("e5")).toHaveCount(0);
            await expect(move("Bc4")).toHaveCount(0);
            await expect(move("Nc6")).toHaveCount(0);
            expect(mountedAfterMouseDown).toBe(1);
            for (const siblingMove of ["c5", "Nf3", "d6"]) {
                await expect(move(siblingMove)).toBeVisible();
            }
            await expect(notation.locator('[data-notation-current="true"] button')).toHaveText(
                "e4",
            );
            await expect
                .poll(() => whitePawnSquares(page.locator("cg-board")))
                .toEqual(["a2", "b2", "c2", "d2", "e4", "f2", "g2", "h2"]);
            await expect(page.getByRole("menu")).toHaveCount(0);
            await expect(
                page.getByText("Unexpected Tauri IPC command", { exact: false }),
            ).toHaveCount(0);
            await capture(`notation-delete-${scope}-${layout}-result`);
        });

        test(`notation-menu: ${scope} ${layout} dismisses and promotes with pointer clicks`, async ({
            page,
            mockScenario,
        }) => {
            const notation = await setupNotationMenu(page, mockScenario, scope, tableLayout);
            const move = (name: string) => notation.getByRole("button", { name, exact: true });
            const current = notation.locator('[data-notation-current="true"] button');
            await move("d6").click();
            await move("c5").click({ button: "right" });
            await expect(page.getByRole("menu")).toBeVisible();
            await move("e4").click();
            await expect(page.getByRole("menu")).toHaveCount(0);
            await expect(current).toHaveText("e4");
            await move("d6").click();
            await move("c5").click({ button: "right" });
            await expect(page.getByRole("menu")).toBeVisible();
            await page.keyboard.press("Escape");
            await expect(page.getByRole("menu")).toHaveCount(0);
            await expect(current).toHaveText("d6");
            const moves = () => notation.getByRole("button").allTextContents();
            const before = await moves();
            expect(before.indexOf("e5")).toBeLessThan(before.indexOf("c5"));
            await move("c5").click({ button: "right" });
            await page.getByRole("menuitem", { name: "Promote Variation", exact: true }).click();
            await expect(page.getByRole("menu")).toHaveCount(0);
            await expect
                .poll(async () => {
                    const after = await moves();
                    return after.indexOf("c5") < after.indexOf("e5");
                })
                .toBe(true);
            await expect(current).toHaveText("d6");
            for (const retainedMove of ["e4", "e5", "Bc4", "Nc6", "c5", "Nf3", "d6"]) {
                await expect(move(retainedMove)).toBeVisible();
            }
        });
    }
}

test("notation-focus: arrow keys after a pointer click leave no focus ring on the clicked move", async ({
    page,
    mockScenario,
}, testInfo) => {
    const notation = await setupNotationMenu(page, mockScenario, "workspace", false);
    const move = (name: string) => notation.getByRole("button", { name, exact: true });
    const current = notation.locator('[data-notation-current="true"] button');
    const focusRings = notation.locator("button:focus-visible");

    // e5 starts a line without branches, so Right steps instead of opening the chooser.
    await move("e5").click();
    await expect(current).toHaveText("e5");
    await page.keyboard.press("ArrowRight");
    await expect(current).toHaveText("Bc4");
    await page.keyboard.press("ArrowRight");
    await expect(current).toHaveText("Nc6");
    // The browser treats focus as keyboard focus after a key press, so a move that kept
    // focus from the click would now draw its ring while the highlight sits elsewhere.
    await expect(focusRings).toHaveCount(0);
    await expect(move("e5")).not.toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("notation-focus-after-arrows.png") });

    // Keyboard activation keeps its focus ring on the activated move. This guards the
    // pointer-only condition: a blur on every activation would turn this red.
    await move("Bc4").focus();
    await page.keyboard.press("Enter");
    await expect(current).toHaveText("Bc4");
    await expect(focusRings).toHaveCount(1);
    await expect(move("Bc4")).toBeFocused();
});

test("engine-gap: warm actor contract preserves ownership and isolates searches", async ({
    page,
}) => {
    await page.goto("/");
    const invoke = (command: string, args: Record<string, unknown>) =>
        page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
            command,
            args,
        });
    const start = (id: string, tab: string, generation: string) =>
        page.evaluate(
            (args) => {
                // Handle the command's rejection without awaiting the still-running search.
                void window.__TAURI_INTERNALS__.invoke("get_best_moves", args).catch(() => {});
            },
            { id, tab, generation },
        );
    const state = () => page.evaluate(() => window.__E2E_TAURI__.engineSearchState());
    const pending = async (...generations: string[]) =>
        expect((await state()).pending).toEqual(generations);
    const cancelled = async (generation: string) =>
        expect((await state()).settled.filter((entry) => entry.generation === generation)).toEqual([
            {
                generation,
                outcome: "cancelled",
                error: { tag: "backend-error", category: "cancellation", message: "Cancellation" },
            },
        ]);
    const stop = (engine: string, tab: string, expectedGeneration: string | null) =>
        invoke("stop_engine", { engine, tab, expectedGeneration });
    const release = (engine: string, tab: string, generation: string) =>
        invoke("release_engine_search", { engine, tab, generation });

    await test.step("(a) same-key supersession and stale generations", async () => {
        await start("contract-engine", "contract-tab", "contract-A");
        await start("contract-engine", "contract-tab", "contract-B");
        await cancelled("contract-A");
        await pending("contract-B");
        expect(await stop("contract-engine", "contract-tab", "contract-A")).toBe(false);
        await pending("contract-B");
        expect(await release("contract-engine", "contract-tab", "contract-A")).toBeNull();
        await pending("contract-B");
        await cancelled("contract-A");
    });

    await test.step("(b) repeated qualified stop retains owner", async () => {
        expect(await stop("contract-engine", "contract-tab", "contract-B")).toBe(true);
        await cancelled("contract-B");
        await pending();
        expect(await stop("contract-engine", "contract-tab", "contract-B")).toBe(true);
        await cancelled("contract-B");
        await pending();
        expect(await release("contract-engine", "contract-tab", "contract-B")).toBeNull();
        expect(await stop("contract-engine", "contract-tab", "contract-B")).toBe(false);
        await cancelled("contract-B");
    });

    await test.step("(c) engine and tab isolation across stop, release and kill", async () => {
        await start("engine-1", "tab-1", "isolation-1");
        await start("engine-1", "tab-2", "isolation-2");
        await start("engine-2", "tab-1", "isolation-3");
        await start("engine-2", "tab-2", "isolation-4");
        await pending("isolation-1", "isolation-2", "isolation-3", "isolation-4");

        expect(await stop("engine-1", "tab-1", "isolation-1")).toBe(true);
        await cancelled("isolation-1");
        await pending("isolation-2", "isolation-3", "isolation-4");

        expect(await release("engine-1", "tab-2", "isolation-2")).toBeNull();
        await cancelled("isolation-2");
        expect(await stop("engine-1", "tab-2", "isolation-2")).toBe(false);
        await pending("isolation-3", "isolation-4");

        expect(await invoke("kill_engine", { engine: "engine-2", tab: "tab-1" })).toBeNull();
        await cancelled("isolation-3");
        expect(await stop("engine-2", "tab-1", "isolation-3")).toBe(false);
        await pending("isolation-4");

        await start("engine-1", "tab-1", "isolation-5");
        await start("engine-2", "tab-1", "isolation-6");
        await start("engine-1", "tab-2", "isolation-7");
        expect(await invoke("kill_engines", { tab: "tab-1" })).toBeNull();
        await cancelled("isolation-5");
        await cancelled("isolation-6");
        expect(await stop("engine-1", "tab-1", "isolation-5")).toBe(false);
        expect(await stop("engine-2", "tab-1", "isolation-6")).toBe(false);
        await pending("isolation-4", "isolation-7");

        expect(await stop("engine-1", "tab-2", "isolation-7")).toBe(true);
        expect(await stop("engine-1", "tab-2", null)).toBe(false);
        await cancelled("isolation-7");
        expect(await stop("engine-1", "tab-2", "isolation-7")).toBe(false);
        await pending("isolation-4");

        expect(await stop("engine-2", "tab-2", "isolation-4")).toBe(true);
        expect(await stop("engine-2", "tab-2", null)).toBe(false);
        await cancelled("isolation-4");
        expect(await stop("engine-2", "tab-2", "isolation-4")).toBe(false);
        await pending();
        const finalState = await state();
        expect(finalState.settled).toHaveLength(9);
        expect(
            finalState.stops
                .filter(({ expectedGeneration }) => expectedGeneration === "contract-B")
                .map(({ result }) => result),
        ).toEqual([true, true, false]);
    });
});

type AnalysisRequest = {
    id: string;
    tab: string;
    generation: string;
    options: { fen: string; moves: string[] };
};

// Native IPC serializes these bigint counters as JSON numbers.
type BestMovesFixturePayload = Omit<BestMovesPayload, "bestLines"> & {
    bestLines: (Omit<BestMovesPayload["bestLines"][number], "nodes" | "nps"> & {
        nodes: number;
        nps: number;
    })[];
};

function bestMovesPayload(
    request: AnalysisRequest,
    sanMoves: string[],
    uciMoves: string[],
    score: number,
): BestMovesFixturePayload {
    return {
        engine: request.id,
        tab: request.tab,
        generation: request.generation,
        fen: request.options.fen,
        moves: request.options.moves,
        progress: 50,
        bestLines: [
            {
                depth: 20,
                multipv: 1,
                nodes: 1234,
                nps: 5678,
                score: { value: { type: "cp", value: score }, wdl: null },
                sanMoves,
                uciMoves,
            },
        ],
    };
}

async function setupAnalysisEngine(page: Page, engineCount = 1) {
    await page.addInitScript((engineCount) => {
        localStorage.setItem("erase-drawables-on-click", "false");
        localStorage.setItem(
            "engines",
            JSON.stringify(
                Array.from({ length: engineCount }, (_, index) => ({
                    type: "local",
                    id: index === 0 ? "e2e-engine" : "e2e-engine-2",
                    name: index === 0 ? "E2E Stockfish" : "E2E ChessDB",
                    version: "19",
                    filename: "stockfish",
                    handle: { id: { id: "e2e-engine-handle" }, kind: "engine" },
                    loaded: true,
                    settings:
                        engineCount === 1 ? [] : [{ type: "string", name: "MultiPV", value: "3" }],
                    go: { t: "Infinite" },
                })),
            ),
        );
    }, engineCount);
    await page.goto("/");
    await page.getByRole("button", { name: /^open$/i }).click();
    await page.getByRole("tab", { name: "Analysis", exact: true }).click();
    await page
        .getByRole("button", {
            name: engineCount === 1 ? "Enable engine" : "Enable all engines",
            exact: true,
        })
        .click();
    const searches = () =>
        page.evaluate(() =>
            window.__E2E_TAURI__
                .invocations()
                .filter(({ command }) => command === "get_best_moves"),
        );
    await expect.poll(async () => (await searches()).length).toBe(engineCount);
    const panel = page.locator(".mantine-Accordion-item").filter({ hasText: "E2E Stockfish" });
    return { searches, panel };
}

for (const colorScheme of ["light", "dark"] as const) {
    test(`engine-gap: two engine cards and signed evaluations in ${colorScheme}`, async ({
        page,
        emitTauriEvent,
        assertAccessible,
        capture,
    }) => {
        await page.emulateMedia({ colorScheme });
        await page.setViewportSize({ width: 1440, height: 1100 });
        await page.addInitScript(
            (scheme) => localStorage.setItem("mantine-color-scheme", scheme),
            colorScheme,
        );
        const { searches } = await setupAnalysisEngine(page, 2);
        for (const { args } of await searches()) {
            const request = args as AnalysisRequest;
            const payload = bestMovesPayload(
                request,
                ["e4", "e5", "Nf3"],
                ["e2e4", "e7e5", "g1f3"],
                request.id === "e2e-engine" ? 34 : -21,
            );
            payload.bestLines.push(
                {
                    ...payload.bestLines[0],
                    multipv: 2,
                    score: { value: { type: "cp", value: -21 }, wdl: null },
                    sanMoves: ["d4", "d5"],
                    uciMoves: ["d2d4", "d7d5"],
                },
                {
                    ...payload.bestLines[0],
                    multipv: 3,
                    score: {
                        value: { type: "cp", value: 0 },
                        wdl: request.id === "e2e-engine" ? [450, 300, 250] : null,
                    },
                    sanMoves: ["Nf3", "d5"],
                    uciMoves: ["g1f3", "d7d5"],
                },
            );
            await emitTauriEvent({ event: "best-moves-payload", payload });
        }
        const rightColumn = page.locator("#topRight");
        // Give both cards room using the same pane resize affordance as the product.
        const splitter = (await page.locator(".mosaic-split.-column").boundingBox())!;
        await page.mouse.move(splitter.x + splitter.width / 2, splitter.y + splitter.height / 2);
        await page.mouse.down();
        await page.mouse.move(splitter.x + splitter.width / 2, 930, { steps: 5 });
        await page.mouse.up();
        await page.mouse.move(0, 0);
        const engines = rightColumn.locator(".mantine-Accordion-item");
        await expect(engines).toHaveCount(2);
        for (const engine of await engines.all()) {
            await expect(
                engine.getByRole("button", { name: "Disable engine", exact: true }),
            ).toBeInViewport({ ratio: 1 });
            await expect(engine.getByRole("button", { name: "e4", exact: true })).toBeVisible();
            await expect(engine.getByText("-0.21", { exact: true }).last()).toBeVisible();
            await expect(engine.getByText("0.00", { exact: true })).toBeVisible();
            await expect(engine.getByText("0.00", { exact: true })).toBeInViewport({ ratio: 1 });
        }
        await expect(rightColumn.getByText("+0.34", { exact: true }).last()).toBeVisible();
        const scoreChips = engines.first().locator("tbody tr > td:first-child > [data-size='md']");
        await expect(scoreChips).toHaveText(["+0.34", "-0.21", "0.00"]);
        const chipBackgrounds = await scoreChips.evaluateAll((chips) =>
            chips.map((chip) => getComputedStyle(chip).backgroundColor),
        );
        expect(
            new Set(chipBackgrounds).size,
            `${colorScheme} score chips have distinct fills`,
        ).toBe(3);
        const negativeSurfaces = await scoreChips.nth(1).evaluate((chip) => ({
            line: getComputedStyle(chip.closest("tr")!).backgroundColor,
            page: getComputedStyle(document.body).backgroundColor,
        }));
        expect(chipBackgrounds[1]).not.toBe(negativeSurfaces.line);
        if (colorScheme === "dark") {
            expect(
                chipBackgrounds[1],
                "Dark Black-better chip uses the page background to separate from its line",
            ).toBe(negativeSurfaces.page);
        }
        await assertAccessible();
        await capture(`analysis-two-engines-${colorScheme}`);
        await expect.soft(rightColumn).toHaveScreenshot(`analysis-two-engines-${colorScheme}.png`, {
            animations: "disabled",
        });
        await scoreChips.nth(2).click();
        await expect(scoreChips.nth(2).getByRole("progressbar")).toHaveCount(3);
        for (const [name, value] of [
            ["White wins", "45%"],
            ["Draw", "30%"],
            ["Black wins", "25%"],
        ]) {
            await expect(
                scoreChips.nth(2).getByRole("progressbar", { name, exact: true }),
            ).toHaveAttribute("aria-valuetext", value);
        }
        await assertAccessible();
        await scoreChips.nth(2).click();
        await expect(scoreChips.nth(2)).toHaveText("0.00");
        await rightColumn.getByRole("button", { name: "Pause all engines", exact: true }).click();
        await expect(
            rightColumn.getByRole("button", { name: "Enable engine", exact: true }),
        ).toHaveCount(2);
        if (colorScheme === "dark") {
            await page.getByRole("link", { name: "Settings", exact: true }).click();
            await page.getByRole("tab", { name: "Appearance", exact: true }).click();
            // The sidebar link's tooltip fades out once the pointer leaves it; axe must not sample it.
            await expect(page.getByRole("tooltip")).toHaveCount(0);
            await assertAccessible();
            await capture("settings-appearance-dark");
            await expect
                .soft(page)
                .toHaveScreenshot("settings-appearance-dark.png", { fullPage: true });
        }
    });
}

test("engine-gap: A lines stay dimmed and inert at B until explicitly emitted B lines arrive", async ({
    page,
    emitTauriEvent,
}) => {
    await page.clock.install({ time: new Date("2026-10-05T12:00:00Z") });
    await page.clock.pauseAt(new Date("2026-10-05T12:01:00Z"));
    const { searches, panel } = await setupAnalysisEngine(page);
    await expect(panel.locator(".mantine-Skeleton-root")).toHaveCount(0);
    await expect(panel).not.toContainText("Loading");
    const emitLines = async (
        index: number,
        sanMoves: string[],
        uciMoves: string[],
        score: number,
    ) => {
        const request = (await searches())[index].args as AnalysisRequest;
        await emitTauriEvent({
            event: "best-moves-payload",
            payload: bestMovesPayload(request, sanMoves, uciMoves, score),
        });
    };
    await emitLines(0, ["e4", "e5", "Nf3"], ["e2e4", "e7e5", "g1f3"], 34);
    await expect(panel.getByRole("button", { name: "e4", exact: true })).toBeVisible();
    await page.mouse.move(1400, 850);
    const before = await panel.boundingBox();
    const board = page.getByRole("grid", { name: "Chessboard, White orientation", exact: true });
    await board.focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await searches()).length).toBe(2);
    const [searchA, searchB] = (await searches()).map(
        ({ args }) => args as { id: string; tab: string; generation: string },
    );
    const engineSearchState = await page.evaluate(() => window.__E2E_TAURI__.engineSearchState());
    expect(engineSearchState.settled).toEqual([
        {
            generation: searchA.generation,
            outcome: "cancelled",
            error: { tag: "backend-error", category: "cancellation", message: "Cancellation" },
        },
    ]);
    expect(engineSearchState.pending).toEqual([searchB.generation]);
    expect(
        engineSearchState.stops.filter(
            ({ engine, tab, expectedGeneration }) =>
                engine === searchA.id &&
                tab === searchA.tab &&
                expectedGeneration === searchA.generation,
        ),
    ).toEqual([
        {
            engine: searchA.id,
            tab: searchA.tab,
            expectedGeneration: searchA.generation,
            result: true,
        },
    ]);
    // Advance the board's animation frames under the controlled clock, below the loading deadline.
    await page.clock.runFor(250);
    await expect(page.getByRole("gridcell", { name: "d4, White Pawn", exact: true })).toHaveCount(
        1,
    );
    const oldRow = panel.locator("tr[inert]").filter({ hasText: "e4" });
    await expect(oldRow).toHaveCount(1);
    await expect(oldRow).toHaveCSS("opacity", "0.5");
    await expect(panel.locator(".mantine-Skeleton-root")).toHaveCount(0);
    await expect(panel).not.toContainText("Loading");
    expect((await panel.boundingBox())!.height).toBe(before!.height);
    const oldMove = oldRow.locator("button").first();
    await oldMove.dispatchEvent("click");
    await oldMove.dispatchEvent("mouseover");
    await oldMove.dispatchEvent("contextmenu");
    await expect.poll(async () => (await searches()).length).toBe(2);
    await expect(page.getByRole("grid")).toHaveCount(1);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page).toHaveScreenshot("engine-gap-dimmed.png", { fullPage: true });
    await emitLines(1, ["d5", "c4"], ["d7d5", "c2c4"], 55);
    await expect(panel.locator("tr[inert]")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "d5", exact: true })).toBeVisible();
    await expect(panel).toContainText("0.55");
    await expect(panel).not.toContainText("Loading");
});

/** The threat line d4 Nf3 as the pinned bar renders it after 1. e4 a6 2. e5 d5. */
const PINNED_THREAT_LINE = "3...d44.♘f3";

test("engine-gap: pinned engine shows up to its own line count and swaps between the tabs and the notation", async ({
    page,
    emitTauriEvent,
    assertAccessible,
}) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.addInitScript(() => localStorage.setItem("mantine-color-scheme", "dark"));
    const { searches, panel } = await setupAnalysisEngine(page, 2);
    await panel.getByRole("button", { name: "Pin engine", exact: true }).click();
    const detached = page.getByTestId("pinned-engine");
    const request = (await searches()).find(
        ({ args }) => (args as AnalysisRequest).id === "e2e-engine",
    )!.args as AnalysisRequest;
    const payload = bestMovesPayload(request, ["e4", "e5", "Nf3"], ["e2e4", "e7e5", "g1f3"], 34);
    payload.bestLines.push(
        {
            ...payload.bestLines[0],
            multipv: 2,
            score: { value: { type: "cp", value: 21 }, wdl: null },
            sanMoves: ["d4", "d5", "c4"],
            uciMoves: ["d2d4", "d7d5", "c2c4"],
        },
        {
            ...payload.bestLines[0],
            multipv: 3,
            score: { value: { type: "cp", value: 0 }, wdl: null },
            sanMoves: ["Nf3", "d5"],
            uciMoves: ["g1f3", "d7d5"],
        },
    );
    await emitTauriEvent({ event: "best-moves-payload", payload });
    const scores = detached.locator("[data-size='sm']:has(> p)");
    await expect(scores).toHaveText(["+0.34", "+0.21", "0.00"]);
    await expect(detached).toContainText("1.e4e52.♘f3");
    const lineCount = detached.getByRole("radiogroup", { name: "Number of lines", exact: true });
    await expect(lineCount.getByRole("radio", { name: "3", exact: true })).toBeChecked();
    await expect(lineCount.getByRole("radio", { name: "4", exact: true })).toBeDisabled();
    await lineCount.getByText("2", { exact: true }).click();
    await expect(scores).toHaveText(["+0.34", "+0.21"]);
    await expect(panel.locator("tbody tr > td:first-child > [data-size='md']")).toHaveText([
        "+0.34",
        "+0.21",
        "0.00",
    ]);
    await page.mouse.move(0, 0);
    await assertAccessible();
    await expect(detached).toHaveScreenshot("pinned-engine-two-lines-dark.png", {
        animations: "disabled",
    });

    // Hovering a pinned move previews the position after it on a board inside the window,
    // and the board stays while the pointer stays on the move (it never takes the pointer).
    const move = detached.getByRole("button", { name: "e5", exact: true }).first();
    await move.hover();
    const preview = page.getByTestId("engine-line-preview");
    await expect(preview.locator("cg-board")).toBeVisible();
    const box = (await preview.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.width).toBeGreaterThan(150);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    const moveBox = (await move.boundingBox())!;
    await page.mouse.move(moveBox.x + moveBox.width - 2, moveBox.y + moveBox.height / 2);
    await expect(preview).toBeVisible();
    await expect(page).toHaveScreenshot("pinned-engine-hover-preview-dark.png", {
        animations: "disabled",
    });
    await page.mouse.move(0, 0);
    await expect(preview).toHaveCount(0);

    // The bar starts above the panel tabs; its swap button moves it above the notation and back.
    const tabList = page.locator("#topRight").getByRole("tablist").first();
    const notation = page.locator("#bottomRight");
    const top = async (locator: typeof detached) => (await locator.boundingBox())!.y;
    expect(await top(detached)).toBeLessThan(await top(tabList));
    await detached.getByRole("button", { name: "Move above the notation", exact: true }).click();
    await expect(
        detached.getByRole("button", { name: "Move above the tabs", exact: true }),
    ).toBeVisible();
    expect(await top(detached)).toBeGreaterThan(await top(tabList));
    expect(await top(detached)).toBeGreaterThanOrEqual(await top(notation));
    await expect(detached).toHaveCount(1);
    await detached.getByRole("button", { name: "Move above the tabs", exact: true }).click();
    await expect(
        detached.getByRole("button", { name: "Move above the notation", exact: true }),
    ).toBeVisible();
    expect(await top(detached)).toBeLessThan(await top(tabList));
});

test("engine-gap: legal threat after a double push becomes unavailable in check and recovers", async ({
    page,
    emitTauriEvent,
}) => {
    await page.clock.install({ time: new Date("2026-10-21T12:00:00Z") });
    const { searches, panel } = await setupAnalysisEngine(page);
    await panel.getByRole("button", { name: "Pin engine", exact: true }).click();
    const detached = page.getByTestId("pinned-engine");
    const board = page.locator("cg-board");
    for (const [index, [from, to]] of [
        ["e2", "e4"],
        ["a7", "a6"],
        ["e4", "e5"],
        ["d7", "d5"],
    ].entries()) {
        await playBoardMove(page, board, from, to);
        await expect.poll(async () => (await searches()).length).toBe(index + 2);
        await page.clock.runFor(250);
    }
    await panel.getByRole("button", { name: "Check the opponent's threat", exact: true }).click();
    await expect.poll(async () => (await searches()).length).toBe(6);
    const request = (await searches())[5].args as AnalysisRequest;
    expect(request.options.fen).toBe(
        "rnbqkbnr/1pp1pppp/p7/3pP3/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 3",
    );
    expect(request.options.moves).toEqual([]);
    const emit = async (request: AnalysisRequest) =>
        emitTauriEvent({
            event: "best-moves-payload",
            payload: bestMovesPayload(request, ["d4", "Nf3"], ["d5d4", "g1f3"], 34),
        });
    await emit(request);
    await expect(panel.getByRole("button", { name: "d4", exact: true })).toBeVisible();
    await expect(detached).toContainText(PINNED_THREAT_LINE);
    const preparations = () =>
        page.evaluate(
            () =>
                window.__E2E_TAURI__
                    .invocations()
                    .filter(({ command }) => command === "prepare_engine_search").length,
        );
    const prepared = await preparations();
    await playBoardMove(page, board, "f1", "b5");
    await page.clock.runFor(1500);
    await expect(panel).toContainText("No analysis available");
    await expect(detached).toContainText("—");
    await emit(request);
    await expect(panel.getByRole("button", { name: "d4", exact: true })).toHaveCount(0);
    await expect(detached).not.toContainText(PINNED_THREAT_LINE);
    await expect(panel).not.toContainText("Loading");
    await expect(panel).not.toContainText("n/s");
    await expect(panel.locator(".mantine-Skeleton-root, [data-animated], tr[inert]")).toHaveCount(
        0,
    );
    await expect(board.locator("svg.cg-shapes line")).toHaveCount(0);
    expect((await searches()).length).toBe(6);
    expect(await preparations()).toBe(prepared);
    const state = await page.evaluate(() => window.__E2E_TAURI__.engineSearchState());
    expect(state.stops).toContainEqual({
        engine: request.id,
        tab: request.tab,
        expectedGeneration: request.generation,
        result: true,
    });
    expect(state.pending).toEqual([]);
    await expect(
        panel.getByRole("button", { name: "Check the opponent's threat", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(panel.getByRole("button", { name: "Disable engine", exact: true })).toBeVisible();
    await expect(page.locator(".mantine-Notification-root")).toHaveCount(0);
    await page.mouse.move(1400, 850);
    await page.clock.runFor(200);
    await expect(page).toHaveScreenshot("engine-threat-unavailable.png", { fullPage: true });
    await page.getByRole("button", { name: "Previous move", exact: true }).click();
    await expect.poll(async () => (await searches()).length).toBe(7);
    const recovered = (await searches())[6].args as AnalysisRequest;
    expect(recovered.options).toEqual(request.options);
    expect(recovered.generation).not.toBe(request.generation);
    await emit(recovered);
    await expect(panel.getByRole("button", { name: "d4", exact: true })).toBeVisible();
    await expect(detached).toContainText(PINNED_THREAT_LINE);
    await expect(panel.locator("tr[inert]")).toHaveCount(0);
    await expect(page.locator(".mantine-Notification-root")).toHaveCount(0);
    await page.mouse.move(1400, 850);
    await page.clock.runFor(250);
    await expect(page).toHaveScreenshot("engine-threat-recovered.png", { fullPage: true });
});

for (const partial of [false, true]) {
    test(`engine-gap: terminal failure ${partial ? "after partial lines" : "before lines"} and explicit Retry`, async ({
        page,
        emitTauriEvent,
        mockScenario,
    }) => {
        await page.clock.install({ time: new Date("2026-10-05T12:00:00Z") });
        await page.clock.pauseAt(new Date("2026-10-05T12:01:00Z"));
        await mockScenario({ commands: { get_engine_logs: { result: [] } } });
        const { searches, panel } = await setupAnalysisEngine(page);
        const request = (await searches())[0].args as AnalysisRequest;
        const payload = bestMovesPayload(
            request,
            ["e4", "e5", "Nf3"],
            ["e2e4", "e7e5", "g1f3"],
            34,
        );
        if (partial) {
            await emitTauriEvent({ event: "best-moves-payload", payload });
            await expect(panel.getByRole("button", { name: "e4", exact: true })).toBeVisible();
        } else {
            await page.clock.runFor(1000);
            await expect(panel.locator(".mantine-Skeleton-root")).toHaveCount(1);
        }
        const failure: ErrorPayload = {
            tag: "engine-failure",
            category: "engine-failure",
            message: "Engine terminated",
            engineFailure: {
                kind: "process-exit",
                exitStatus: { code: 1, signal: null },
                reason: "CRITICAL ERROR: Command rejected. Reason: invalid position",
                entries: [
                    {
                        type: "infoString",
                        value: "CRITICAL ERROR: Command rejected. Reason: invalid position",
                    },
                    { type: "stderr", value: "<b>Safe terminal stderr</b>" },
                    { type: "truncated" },
                ],
            },
        };
        expect(
            await page.evaluate(
                ({ request, failure }) =>
                    window.__E2E_TAURI__.failEngineSearch(
                        request.id,
                        request.tab,
                        request.generation,
                        failure,
                    ),
                { request, failure },
            ),
        ).toBe(true);
        await expect(panel).toContainText("Engine failed");
        await expect(panel).toContainText(failure.engineFailure!.reason!);
        await page.clock.runFor(5000);
        await expect(panel.locator(".mantine-Skeleton-root")).toHaveCount(0);
        await expect(panel).not.toContainText("Loading");
        await expect(panel).not.toContainText("n/s");
        await expect(panel.locator("[data-animated]")).toHaveCount(0);
        await expect(panel.locator("tr[inert]")).toHaveCount(partial ? 1 : 0);
        if (partial) await expect(panel.locator("tr[inert]")).toHaveCSS("opacity", "0.5");
        await emitTauriEvent({ event: "best-moves-payload", payload });
        await expect(panel.locator("tr[inert]")).toHaveCount(partial ? 1 : 0);
        await expect(panel).toContainText("Engine failed");
        await page.mouse.move(1400, 850);
        await page.clock.runFor(200);
        await expect(page).toHaveScreenshot(
            partial ? "engine-failure-historical-lines.png" : "engine-failure-before-lines.png",
            { fullPage: true },
        );
        if (partial) {
            await page.getByRole("tab", { name: "Logs", exact: true }).click();
            await expect(page.getByText("Terminal diagnostics", { exact: true })).toBeVisible();
            await expect(
                page.getByText("<b>Safe terminal stderr</b>", { exact: true }),
            ).toBeVisible();
            await expect(page).toHaveScreenshot("engine-failure-terminal-logs.png", {
                fullPage: true,
            });
            await page.getByRole("tab", { name: "Engines", exact: true }).click();
        }
        await panel.getByRole("button", { name: "Retry", exact: true }).click();
        await expect.poll(async () => (await searches()).length).toBe(2);
        const retried = (await searches())[1].args as typeof request;
        expect(retried.options).toEqual(request.options);
        expect(retried.generation).not.toBe(request.generation);
        await expect(panel).not.toContainText("Engine failed");
        await emitTauriEvent({ event: "best-moves-payload", payload });
        await emitTauriEvent({
            event: "best-moves-payload",
            payload: { ...payload, generation: retried.generation },
        });
        await expect(panel.locator("tr[inert]")).toHaveCount(0);
        await expect(panel.getByRole("button", { name: "e4", exact: true })).toBeVisible();
        await page.getByRole("tab", { name: "Logs", exact: true }).click();
        await expect(page.getByText("Terminal diagnostics", { exact: true })).toHaveCount(0);
        await expect(page.getByText("No logs available yet", { exact: true })).toBeVisible();
    });
}
