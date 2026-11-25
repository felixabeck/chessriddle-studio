import {
    expect,
    test,
    filesWorkspaceCommands,
    filesWorkspaceFixture,
    pgnFileCommands,
    selectFilesTreeRow,
    whitePawnSquares,
    playBoardMove,
    bestMovesPayload,
    seedAnalysisEngines,
    type AnalysisRequest,
    type MockScenario,
    goToSettings,
    scrollbarFreeScreenshot,
    moveBackground,
    CURRENT_MOVE_FILL,
    CURRENT_MOVE_HOVER,
} from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import type { EngineOptions, ErrorPayload } from "../src/bindings/generated";

async function setupNotationMenu(
    page: Page,
    mockScenario: (scenario: MockScenario) => Promise<void>,
    scope: "workspace" | "preview",
    tableLayout: boolean,
    /** Tokens inserted after e5, for a test that annotates it. */
    afterE5: { type: "Nag"; value: string }[] = [],
) {
    await mockScenario({
        commands: filesWorkspaceCommands([[filesWorkspaceFixture.pgnFile]], {
            ...pgnFileCommands,
            write_game: { result: { stamp: "e".repeat(64), revision: "e2e-pgn-revision" } },
            lex_pgn: {
                result: [
                    { type: "San", value: "e4" },
                    { type: "San", value: "e5" },
                    ...afterE5,
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
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
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

for (const colorScheme of ["light", "dark"] as const) {
    test(`notation-hover: plain moves hover in warm beige, annotated ones in their colour, the current move in gold, ${colorScheme}`, async ({
        page,
        mockScenario,
    }, testInfo) => {
        await page.emulateMedia({ colorScheme });
        await page.addInitScript(
            (colorScheme) => localStorage.setItem("mantine-color-scheme", colorScheme),
            colorScheme,
        );
        // e5 carries "!", so its own annotation hover competes with the current-move hover.
        const notation = await setupNotationMenu(page, mockScenario, "workspace", false, [
            { type: "Nag", value: "$1" },
        ]);
        await expect(page.locator("html")).toHaveAttribute(
            "data-mantine-color-scheme",
            colorScheme,
        );
        const move = (name: string) => notation.getByRole("button", { name, exact: true });
        await move("e4").click();
        await expect(move("e4")).toHaveAttribute("aria-current", "true");

        // A non-current annotated move hovers in its own annotation tint: "!" is Mantine's
        // teal-6 (#12b886) at 0.1.
        await move("e5!").hover();
        await expect(move("e5!")).toHaveCSS("background-color", "rgba(18, 184, 134, 0.1)");

        await move("e5!").click();
        await expect(move("e5!")).toHaveAttribute("aria-current", "true");
        await page.mouse.move(0, 0);
        const resting = await moveBackground(move("e5!"), CURRENT_MOVE_FILL);
        expect(resting.actual).toBe(resting.expected);

        await move("Bc4").hover();
        const plain = await moveBackground(move("Bc4"), "var(--cf-move-hover)");
        expect(plain.actual).toBe(plain.expected);
        // A variation sits on surface-inset, where an opaque card hover would vanish.
        await move("c5").hover();
        const variation = await moveBackground(move("c5"), "var(--cf-move-hover)");
        expect(variation.actual).toBe(variation.expected);
        await notation.screenshot({
            path: testInfo.outputPath(`notation-hover-variation-${colorScheme}.png`),
        });

        await move("e5!").hover();
        const current = await moveBackground(move("e5!"), CURRENT_MOVE_HOVER);
        expect(current.actual).toBe(current.expected);
    });
}

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

async function setupAnalysisEngine(page: Page, engineCount = 1) {
    await seedAnalysisEngines(
        page,
        Array.from({ length: engineCount }, (_, index) => ({
            id: index === 0 ? "e2e-engine" : "e2e-engine-2",
            name: index === 0 ? "E2E Stockfish" : "E2E ChessDB",
            handleId: "e2e-engine-handle",
            settings: engineCount === 1 ? [] : [{ type: "string", name: "MultiPV", value: "3" }],
        })),
    );
    await page.goto("/");
    await page.getByRole("button", { name: /^Analysis Board$/ }).click();
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
            await goToSettings(page);
            await page.getByRole("tab", { name: "General", exact: true }).click();
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

test("engine-gap: engines reorder from the keyboard on their grip", async ({ page }) => {
    await setupAnalysisEngine(page, 2);
    const names = page.locator(".mantine-Accordion-item").getByText(/^E2E (Stockfish|ChessDB)$/);
    await expect(names).toHaveText(["E2E Stockfish", "E2E ChessDB"]);
    // The grip is a button: the keyboard lift starts on the button itself, the route the
    // library's interactive-element check blocks.
    await page.getByRole("button", { name: "Reorder engine", exact: true }).first().focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Space");
    await expect(names).toHaveText(["E2E ChessDB", "E2E Stockfish"]);
});

test("engine-gap: pinned engine shows up to its own line count and moves between its four places", async ({
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
    for (const count of [1, 2, 3, 4, 5]) {
        await expect(
            lineCount.getByRole("radio", { name: String(count), exact: true }),
        ).toBeEnabled();
    }
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
    // The previewed move takes the notation's gold current-move hover, not a gray fill.
    await expect(move).toHaveAttribute("aria-current", "true");
    const previewed = await moveBackground(move, CURRENT_MOVE_HOVER);
    expect(previewed.actual).toBe(previewed.expected);
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
        // A hover scrollbar can outlive the pointer, and it is not what this image pins.
        stylePath: scrollbarFreeScreenshot,
    });
    await page.mouse.move(0, 0);
    await expect(preview).toHaveCount(0);

    await lineCount.getByText("4", { exact: true }).click();
    const raisedSearch = async () =>
        (await searches()).findLast(({ args }) => {
            const request = args as AnalysisRequest & { options: EngineOptions };
            return (
                request.id === "e2e-engine" &&
                request.options.extraOptions.some(
                    (option) =>
                        option.name === "MultiPV" &&
                        option.type === "string" &&
                        option.value === "4",
                )
            );
        })?.args as AnalysisRequest | undefined;
    await expect.poll(raisedSearch).toBeDefined();
    const raisedRequest = (await raisedSearch())!;
    const fourthLine = {
        ...payload.bestLines[0],
        multipv: 4,
        score: { value: { type: "cp" as const, value: -10 }, wdl: null },
        sanMoves: ["c4", "e5"],
        uciMoves: ["c2c4", "e7e5"],
    };
    await emitTauriEvent({
        event: "best-moves-payload",
        payload: {
            ...bestMovesPayload(raisedRequest, ["e4", "e5", "Nf3"], ["e2e4", "e7e5", "g1f3"], 34),
            bestLines: [...payload.bestLines, fourthLine],
        },
    });
    await expect(lineCount.getByRole("radio", { name: "4", exact: true })).toBeChecked();
    await expect(scores).toHaveText(["+0.34", "+0.21", "0.00", "-0.10"]);
    await expect(detached).toContainText("1.c4e5");

    // The bar starts above the panel tabs. Its position menu names every slot and moves it there.
    const tabList = page.locator("#topRight").getByRole("tablist").first();
    const right = page.locator("#bottomRight");
    // The first card in the column that is not the engine bar itself.
    const notationCard = right
        .locator(".mantine-Paper-root:not([data-testid='pinned-engine'])")
        .first();
    const rect = async (locator: Locator) => (await locator.boundingBox())!;
    const top = async (locator: Locator) => (await rect(locator)).y;
    const bottom = async (locator: Locator) => {
        const { y, height } = await rect(locator);
        return y + height;
    };
    expect(await top(detached)).toBeLessThan(await top(tabList));
    await detached.getByRole("button", { name: "Engine position", exact: true }).click();
    const items = page.getByRole("menuitem");
    await expect(items).toHaveText([
        "Above the tabs",
        "Above the notation",
        "Below the notation",
        "Below the board",
    ]);
    await expect(items.and(page.locator("[aria-current='true']"))).toHaveText("Above the tabs");
    await items.getByText("Above the notation", { exact: true }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(detached).toHaveCount(1);
    expect(await top(detached)).toBeGreaterThan(await top(tabList));
    expect(await bottom(detached)).toBeLessThanOrEqual((await top(notationCard)) + 0.5);
    // Focus follows the bar into its new slot.
    await expect(
        detached.getByRole("button", { name: "Engine position", exact: true }),
    ).toBeFocused();

    // Below the notation, the bar closes the right column and takes the same room from the
    // notation as above it.
    // The notation card cannot shrink below its tool column, so a short pane scrolls the column
    // in either notation slot; this check uses a pane tall enough for all four lines.
    await page.setViewportSize({ width: 1440, height: 1200 });
    const cardAbove = (await rect(notationCard)).height;
    await detached.getByRole("button", { name: "Engine position", exact: true }).click();
    await items.getByText("Below the notation", { exact: true }).click();
    await expect(detached).toHaveCount(1);
    expect(await top(detached)).toBeGreaterThanOrEqual((await bottom(notationCard)) - 0.5);
    await expect.poll(async () => (await bottom(right)) - (await bottom(detached))).toBeLessThan(2);
    expect(await bottom(detached)).toBeLessThanOrEqual((await bottom(right)) + 0.5);
    expect((await rect(notationCard)).height).toBeCloseTo(cardAbove, 0);
    await expect(right).toHaveScreenshot("pinned-engine-below-notation.png", {
        animations: "disabled",
    });

    await detached.getByRole("button", { name: "Engine position", exact: true }).click();
    await items.getByText("Below the board", { exact: true }).click();
    await expect(page.locator("#left").getByTestId("pinned-engine")).toHaveCount(1);
    await expect(detached).toHaveCount(1);
    await detached.getByRole("button", { name: "Engine position", exact: true }).click();
    await items.getByText("Above the tabs", { exact: true }).click();
    expect(await top(detached)).toBeLessThan(await top(tabList));
    await expect(
        detached.getByRole("button", { name: "Engine position", exact: true }),
    ).toBeFocused();
});

test("engine-gap: the pinned engine below the board stays inside the left pane and the board makes room", async ({
    page,
    emitTauriEvent,
}) => {
    const { searches, panel } = await setupAnalysisEngine(page, 2);
    await panel.getByRole("button", { name: "Pin engine", exact: true }).click();
    const detached = page.getByTestId("pinned-engine");
    const lineCount = detached.getByRole("radiogroup", { name: "Number of lines", exact: true });
    await lineCount.getByText("4", { exact: true }).click();
    const raisedSearch = async () =>
        (await searches()).findLast(({ args }) => {
            const request = args as AnalysisRequest & { options: EngineOptions };
            return (
                request.id === "e2e-engine" &&
                request.options.extraOptions.some(
                    (option) =>
                        option.name === "MultiPV" &&
                        option.type === "string" &&
                        option.value === "4",
                )
            );
        })?.args as AnalysisRequest | undefined;
    await expect.poll(raisedSearch).toBeDefined();
    const payload = bestMovesPayload(
        (await raisedSearch())!,
        ["e4", "e5", "Nf3"],
        ["e2e4", "e7e5", "g1f3"],
        34,
    );
    payload.bestLines.push(
        ...[2, 3, 4].map((multipv) => ({
            ...payload.bestLines[0],
            multipv,
            score: { value: { type: "cp" as const, value: 40 - 10 * multipv }, wdl: null },
        })),
    );
    await emitTauriEvent({ event: "best-moves-payload", payload });
    const scores = detached.locator("[data-size='sm']:has(> p)");
    await expect(scores).toHaveCount(4);

    const left = page.locator("#left");
    const card = left.locator(".mantine-Paper-root").first();
    const surface = left.locator("[data-board-surface]");
    const box = async (locator: Locator) => (await locator.boundingBox())!;
    const bottom = async (locator: Locator) => {
        const { y, height } = await box(locator);
        return y + height;
    };
    const boardSize = async () => (await box(surface)).height;
    const moveTo = async (position: string) => {
        await detached.getByRole("button", { name: "Engine position", exact: true }).click();
        await page.getByRole("menuitem", { name: position, exact: true }).click();
        await expect(page.getByRole("menu")).toHaveCount(0);
    };
    const belowBoard = async () => {
        await moveTo("Below the board");
        await expect(left.getByTestId("pinned-engine")).toHaveCount(1);
    };
    /** Board, player bars and engine bar lie inside the left pane, and none is clipped or overlaps. */
    const expectFits = async () => {
        expect(await card.evaluate((node) => node.scrollHeight <= node.clientHeight)).toBe(true);
        for (const bar of await left.locator("[data-board-bar]").all()) {
            expect(await bottom(bar)).toBeLessThanOrEqual((await bottom(card)) + 0.5);
        }
        expect((await box(detached)).y).toBeGreaterThanOrEqual((await bottom(card)) - 0.5);
        expect(await bottom(detached)).toBeLessThanOrEqual((await bottom(left)) + 0.5);
    };

    // Height-bounded: the board gives up exactly the bar and its gap, whatever the bar's height.
    await page.setViewportSize({ width: 1440, height: 700 });
    await expect.poll(boardSize).toBeLessThan((await box(left)).width - 50);
    const above = await boardSize();
    await belowBoard();
    await expectFits();

    // A preview from the last line has no room below it, so it opens upward over the board and
    // must paint in front of it, not behind its chessground layers.
    await detached.getByRole("button", { name: "e5", exact: true }).last().hover();
    const preview = page.getByTestId("engine-line-preview");
    await expect(preview.locator("cg-board")).toBeVisible();
    const boardSurface = await surface.elementHandle();
    const previewOnTop = await preview.evaluate((node: HTMLElement, board) => {
        const a = node.getBoundingClientRect();
        const b = (board as HTMLElement).getBoundingClientRect();
        const overlap = {
            left: Math.max(a.left, b.left),
            right: Math.min(a.right, b.right),
            top: Math.max(a.top, b.top),
            bottom: Math.min(a.bottom, b.bottom),
        };
        if (overlap.right <= overlap.left || overlap.bottom <= overlap.top) return "no overlap";
        // Hit testing skips `pointer-events: none`; enable it just for this synchronous probe.
        node.style.pointerEvents = "auto";
        const hit = document.elementFromPoint(
            (overlap.left + overlap.right) / 2,
            (overlap.top + overlap.bottom) / 2,
        );
        node.style.pointerEvents = "none";
        return hit !== null && node.contains(hit) ? "preview" : (hit?.tagName ?? "nothing");
    }, boardSurface);
    expect(previewOnTop).toBe("preview");
    await page.mouse.move(0, 0);
    await expect(preview).toHaveCount(0);

    const reserve = async () => (await bottom(detached)) - (await bottom(card));
    await expect
        .poll(async () => above - (await boardSize()) - (await reserve()))
        .toBeCloseTo(0, 0);
    const fourLines = { board: await boardSize(), bar: (await box(detached)).height };
    await lineCount.getByText("1", { exact: true }).click();
    await expect(scores).toHaveCount(1);
    await expect
        .poll(
            async () =>
                (await boardSize()) -
                fourLines.board -
                (fourLines.bar - (await box(detached)).height),
        )
        .toBeCloseTo(0, 0);
    expect((await box(detached)).height).toBeLessThan(fourLines.bar - 20);
    await expectFits();
    await lineCount.getByText("4", { exact: true }).click();
    await expect(scores).toHaveCount(4);
    await moveTo("Above the notation");
    await expect.poll(boardSize).toBeCloseTo(above, 0);

    // Width-bounded with room below: the board keeps its size.
    await page.setViewportSize({ width: 1000, height: 1400 });
    await expect
        .poll(async () => (await bottom(left)) - (await bottom(surface)))
        .toBeGreaterThan(400);
    const wide = await boardSize();
    await belowBoard();
    await expect.poll(boardSize).toBeCloseTo(wide, 0);
    await expectFits();
    await expect(left).toHaveScreenshot("pinned-engine-below-board.png", {
        animations: "disabled",
    });

    // Stacked: the bar follows the board in flow, before the next pane.
    await page.setViewportSize({ width: 600, height: 900 });
    await expect(page.locator("[data-board-layout='stacked']")).toBeVisible();
    await detached.scrollIntoViewIfNeeded();
    await expect(detached).toBeVisible();
    expect((await box(detached)).y).toBeGreaterThanOrEqual((await bottom(card)) - 0.5);
    expect(await bottom(detached)).toBeLessThanOrEqual(
        (await box(page.locator("[data-board-slot='topRight']"))).y + 0.5,
    );
    expect(await card.evaluate((node) => node.scrollHeight <= node.clientHeight)).toBe(true);
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
