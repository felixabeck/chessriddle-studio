import {
    expect,
    test,
    filesWorkspaceCommands,
    filesWorkspaceFixture,
    gameReportCommands,
    pgnFileCommands,
    scrollbarFreeScreenshot,
    seedAnalysisEngines,
    selectFilesTreeRow,
    type GameReportFixture,
    type MockScenario,
} from "./fixtures";
import type { Page } from "@playwright/test";

// 1.e4 e5 2.Qh5 Nc6 3.Bc4 Nf6 4.Qxf7#
const GAME = ["e4", "e5", "Qh5", "Nc6", "Bc4", "Nf6", "Qxf7#"];

function line(uciMoves: string[], score: { type: "cp" | "mate"; value: number }, multipv = 1) {
    return {
        depth: 18,
        multipv,
        nodes: 1_000_000,
        nps: 2_000_000,
        score: { value: score, wdl: null },
        sanMoves: uciMoves,
        uciMoves,
    };
}
const cp = (value: number) => ({ type: "cp" as const, value });
const evaluated = (...best: ReturnType<typeof line>[]) => ({
    best,
    terminal: null,
    isSacrifice: false,
});

/** Positions root first, White-relative: 2.Qh5 drops a little (?!), 3...Nf6 allows mate (??). */
const REPORT: GameReportFixture = {
    positions: [
        evaluated(line(["e2e4"], cp(20)), line(["d2d4"], cp(18), 2)),
        evaluated(line(["e7e5"], cp(25)), line(["c7c5"], cp(30), 2)),
        evaluated(line(["g1f3", "b8c6"], cp(30)), line(["b1c3"], cp(20), 2)),
        evaluated(line(["b8c6"], cp(-60)), line(["g8f6"], cp(-80), 2)),
        evaluated(line(["f1c4"], cp(-40)), line(["d2d3"], cp(-60), 2)),
        evaluated(line(["g7g6", "h5f3"], cp(-50)), line(["d8e7"], cp(-40), 2)),
        evaluated(line(["h5f7"], { type: "mate", value: 1 }), line(["h5f5"], cp(200), 2)),
        { best: [], terminal: "checkmate", isSacrifice: false },
    ],
    novelty: { kind: "notRequested" },
};

async function openReportTab(
    page: Page,
    mockScenario: (scenario: MockScenario) => Promise<void>,
    { engine }: { engine: boolean },
) {
    if (engine)
        await seedAnalysisEngines(page, [
            { id: "stockfish", name: "Stockfish 17", handleId: "engine-handle" },
        ]);
    await mockScenario({
        commands: filesWorkspaceCommands([[filesWorkspaceFixture.pgnFile]], {
            ...pgnFileCommands,
            ...gameReportCommands(REPORT),
            write_game: { result: { stamp: "e".repeat(64), revision: "e2e-pgn-revision" } },
            lex_pgn: {
                result: [
                    { type: "Header", value: { tag: "White", value: "Weiss" } },
                    { type: "Header", value: { tag: "Black", value: "Schwarz" } },
                    { type: "Header", value: { tag: "Result", value: "1-0" } },
                    ...GAME.map((value) => ({ type: "San", value })),
                    { type: "Outcome", value: "1-0" },
                ],
            },
        }),
    });
    // The provenance line shows the report's date.
    await page.clock.setFixedTime(new Date("2026-11-22T10:00:00Z"));
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    await selectFilesTreeRow(page, filesWorkspaceFixture.pgnFile.name);
    await page.getByRole("button", { name: "Open game", exact: true }).click();
    await page.getByRole("tab", { name: "Analysis", exact: true }).click();
    await page.getByRole("tab", { name: "Report", exact: true }).click();
    const panel = page.getByRole("tabpanel", { name: "Report", exact: true });
    await expect(panel.getByText(/This game has no evaluations yet/)).toBeVisible();
    return panel;
}

test("game report: an empty Report tab offers the report and the dialog says what it will do", async ({
    page,
    mockScenario,
    assertAccessible,
}) => {
    const panel = await openReportTab(page, mockScenario, { engine: true });
    await expect(panel).toHaveScreenshot("report-empty.png", {
        stylePath: scrollbarFreeScreenshot,
    });
    await assertAccessible();

    await panel.getByRole("button", { name: "Generate report", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Generate report" });
    await expect(dialog.getByRole("checkbox", { name: "Mark moves" })).toBeChecked();
    // Without a reference database the novelty option is off and says how to get one.
    await expect(dialog.getByRole("checkbox", { name: "Mark the novelty" })).toBeDisabled();
    await expect(dialog.getByRole("link", { name: "Library" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Analyze", exact: true })).toBeEnabled();
    await expect(dialog).toHaveScreenshot("report-dialog.png", {
        stylePath: scrollbarFreeScreenshot,
    });
    await assertAccessible();
});

test("game report: the dialog without an engine points to the engines page", async ({
    page,
    mockScenario,
    assertAccessible,
}) => {
    const panel = await openReportTab(page, mockScenario, { engine: false });
    await panel.getByRole("button", { name: "Generate report", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Generate report" });
    await expect(dialog.getByRole("link", { name: "Add an engine" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Analyze", exact: true })).toBeDisabled();
    await expect(dialog).toHaveScreenshot("report-dialog-no-engine.png", {
        stylePath: scrollbarFreeScreenshot,
    });
    await assertAccessible();
});

test("game report: a run fills the Report tab from the native result", async ({
    page,
    mockScenario,
    assertAccessible,
}) => {
    const panel = await openReportTab(page, mockScenario, { engine: true });
    await panel.getByRole("button", { name: "Generate report", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Generate report" });
    await dialog.getByRole("button", { name: "Analyze", exact: true }).click();
    await expect(dialog).toBeHidden();

    // Accuracy, marks and provenance come from the payload above, not from a seeded tree.
    await expect(panel.getByTestId("report-accuracy")).toHaveCount(2);
    await expect(panel.getByTestId("report-provenance")).toHaveText(
        "Analyzed by Stockfish 17, 0.5 s per position, on Nov 22, 2026.",
    );
    const invocations = await page.evaluate(() => window.__E2E_TAURI__.invocations());
    const analyze = invocations.find(({ command }) => command === "analyze_game");
    expect(analyze?.args).toMatchObject({
        id: "report_e2e-tab_operation",
        engineId: "stockfish",
        goMode: { t: "Time", c: 500 },
        options: { annotateNovelties: false },
    });
    expect((analyze!.args as { options: { moves: string[] } }).options.moves).toHaveLength(7);
    await expect(panel.getByRole("button", { name: "Regenerate report" })).toBeVisible();
    const moments = panel.getByTestId("report-key-moment");
    await expect(moments).toHaveCount(2);
    await expect(moments.nth(0)).toContainText("2. Qh5?!");
    await expect(moments.nth(0)).toContainText("Better: Nf3");
    await expect(moments.nth(1)).toContainText("3... Nf6??");
    await expect(moments.nth(1)).toContainText("Better: g6");
    // The pointer still rests where Analyze was; a chart tooltip would land in the picture.
    await page.mouse.move(0, 0);
    await expect(panel).toHaveScreenshot("report-populated.png", {
        stylePath: scrollbarFreeScreenshot,
    });
    const keyMoments = panel.getByRole("list", { name: "Key moments" });
    await keyMoments.scrollIntoViewIfNeeded();
    await expect(keyMoments).toHaveScreenshot("report-key-moments.png", {
        stylePath: scrollbarFreeScreenshot,
    });
    // Annotated notation moves fail colour contrast in the light scheme: f-20261122-06.
    await assertAccessible({ exclude: ['[class*="_moveText_"]'] });

    // A key moment goes to its move.
    await moments.nth(1).click();
    await expect(page.locator('[data-notation-current="true"] button')).toContainText("f6??");
});
