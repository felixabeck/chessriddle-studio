import { INITIAL_FEN } from "chessops/fen";
import type { Locator, Page } from "@playwright/test";
import type { AccountError, TrainingPuzzle, TrainingVerdict } from "../src/bindings/generated";
import en from "../src/translation/en-US.json" with { type: "json" };
import de from "../src/translation/de-DE.json" with { type: "json" };
import { deserializeStorageValue } from "../src/state/store/debouncedStorage";
import {
    activeWorkspaceTab,
    expect,
    playBoardMove,
    preserveStorageForReload,
    splitTextWords,
    test,
    waitForTransitionsSettled,
    type MockScenario,
} from "./fixtures";

const puzzle: TrainingPuzzle = {
    id: 1,
    source: "tactics",
    preEntranceFen: INITIAL_FEN,
    entranceMove: "e2e4",
    decisionFen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    sideToMove: "black",
    puzzleRating: 1500,
    solutionPlyCount: 3,
};
const verdict: TrainingVerdict = {
    isCorrect: true,
    tooShort: false,
    ratingChange: 8,
    playerRating: 1508,
    puzzleRating: 1500,
    rated: true,
    ratingPending: false,
    feedbackCode: "correct",
    feedbackContext: "analysis",
    correctVariation: ["e7e5", "g1f3", "b8c6"],
    incorrectMove: null,
    correctMove: null,
};
const commands: NonNullable<MockScenario["commands"]> = {
    chessriddle_training_available: { result: true },
    chessriddle_training_next: { result: puzzle },
    chessriddle_mistake_count: { result: 2 },
    chessriddle_training_submit: { result: verdict },
    chessriddle_open_upgrade: { result: null },
    chessriddle_account: { result: { status: "disconnected" } },
    connect_chessriddle: {
        result: {
            status: "connected",
            account: { handle: "account", username: "Alex", plan: "gold" },
            durability_uncertain: false,
        },
    },
};

async function playTrainingMove(page: Page, board: Locator, from: string, to: string) {
    const flipped = await board.evaluate((element) =>
        element.closest(".cg-wrap")?.classList.contains("orientation-black"),
    );
    const square = (value: string) =>
        flipped
            ? `${String.fromCharCode(104 - (value.charCodeAt(0) - 97))}${9 - Number(value[1])}`
            : value;
    await playBoardMove(page, board, square(from), square(to));
}

async function captureTraining(
    page: Page,
    target: Page | Locator,
    name: string,
    scrollToBottom = true,
) {
    await page.mouse.move(0, 0);
    await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
    });
    await waitForTransitionsSettled(page);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await page.evaluate(() => document.fonts.ready);
    if (target !== page) {
        const element = target as Locator;
        if (scrollToBottom)
            await element.evaluate((node) => {
                node.scrollTop = node.scrollHeight;
            });
        await element.scrollIntoViewIfNeeded();
        await expect.soft(element).toHaveScreenshot(name);
    } else {
        await expect.soft(page).toHaveScreenshot(name);
    }
}

async function assertControlLabelsFit(panel: Locator) {
    const labels = panel.locator(".mantine-Button-label, .mantine-SegmentedControl-label");
    const split = await splitTextWords(labels);
    const geometry = split.length
        ? await labels.evaluateAll((elements) =>
              elements.map((element) => ({
                  text: element.textContent,
                  width: element.clientWidth,
                  font: getComputedStyle(element).fontSize,
                  parentFont: getComputedStyle(element.parentElement!).fontSize,
                  parent: element.parentElement!.className,
              })),
          )
        : [];
    expect(
        split,
        `button labels must fit without splitting words: ${JSON.stringify(geometry)}`,
    ).toEqual([]);
    const clipped = await labels.evaluateAll((elements) =>
        elements
            .filter((label) => label.scrollWidth > label.clientWidth + 1)
            .map((label) => label.textContent ?? ""),
    );
    expect(clipped, "button labels must fit without clipping").toEqual([]);
}

for (const layout of ["desktop", "narrow"] as const) {
    test(`${layout}: switching sources retains the tab and both puzzle sessions`, async ({
        page,
        mockScenario,
        assertNoHorizontalOverflow,
    }) => {
        await page.setViewportSize({ width: layout === "narrow" ? 320 : 1440, height: 900 });
        await page.addInitScript(() => {
            localStorage.setItem("puzzle-db", JSON.stringify({ id: "offline-puzzles" }));
            localStorage.setItem("board-animation-speed", JSON.stringify("off"));
            localStorage.setItem("track-puzzle-time", "false");
        });
        await mockScenario({
            commands: {
                ...commands,
                list_puzzle_databases: {
                    result: [
                        {
                            title: "Offline.db3",
                            description: "Offline",
                            puzzleCount: 1,
                            storageSize: "1024",
                            path: { id: "offline-puzzles" },
                        },
                    ],
                },
                get_puzzle_themes: { result: [] },
                get_themes_for_puzzle: { result: [] },
                get_puzzle: {
                    result: {
                        id: 7,
                        fen: INITIAL_FEN,
                        moves: "e2e4 e7e5 g1f3 b8c6",
                        rating: 1200,
                        rating_deviation: 50,
                        popularity: 1,
                        nb_plays: 1,
                    },
                },
            },
        });
        await page.goto("/");
        await page.getByRole("button", { name: "Puzzles", exact: true }).click();
        await expect(
            page.locator("[data-training-panel]").getByText("Black to move", { exact: true }),
        ).toBeVisible();
        const owner = (await activeWorkspaceTab(page))!;
        await playTrainingMove(page, page.locator("#left cg-board"), "e7", "e5");
        await page
            .locator(".mantine-SegmentedControl-label")
            .filter({ hasText: /^Offline databases$/ })
            .click();
        await page.getByRole("button", { name: "New Puzzle", exact: true }).click();
        await expect(page.locator("#left cg-board piece")).toHaveCount(32);
        await page
            .locator(".mantine-SegmentedControl-label")
            .filter({ hasText: /^ChessRiddle$/ })
            .click();
        await expect(
            page.locator("#bottomRight").getByRole("button", { name: "e5", exact: true }),
        ).toBeVisible();
        await page
            .locator(".mantine-SegmentedControl-label")
            .filter({ hasText: /^Offline databases$/ })
            .click();
        await expect(page.locator("#left cg-board piece")).toHaveCount(32);
        expect((await activeWorkspaceTab(page))!.value).toBe(owner.value);
        const offlinePanel = page.locator("#topRight .mantine-Paper-root").first();
        await expect(
            offlinePanel.getByRole("radio", { name: "Offline databases", exact: true }),
        ).toBeChecked();
        await assertControlLabelsFit(offlinePanel);
        await assertNoHorizontalOverflow();
        await captureTraining(page, page, `en-US-${layout}-offline.png`);
        expect(
            await page.evaluate(() =>
                window.__E2E_TAURI__.invocations().filter((call) => call.command === "get_puzzle"),
            ),
        ).toHaveLength(1);
        expect(
            await page.evaluate(() =>
                window.__E2E_TAURI__
                    .invocations()
                    .filter((call) => call.command === "chessriddle_training_next"),
            ),
        ).toHaveLength(1);
    });
}

test("unavailable connection keeps the existing offline Puzzles entry and view", async ({
    page,
}) => {
    await page.goto("/");
    await expect(page.locator("[data-home-action]")).toHaveCount(5);
    await page.getByRole("button", { name: "Puzzles", exact: true }).click();
    await expect(page.getByPlaceholder("Select database")).toBeVisible();
    await expect(page.getByRole("radio", { name: "ChessRiddle", exact: true })).toHaveCount(0);
    expect((await activeWorkspaceTab(page))!.puzzleSource).toBeUndefined();
});

for (const locale of ["en-US", "de-DE"] as const) {
    const catalogue = locale === "de-DE" ? de.translation : en.translation;
    const text = (key: keyof typeof en.translation) => catalogue[key];
    test.describe(locale, () => {
        test.use({ appLocale: locale });
        for (const layout of ["desktop", "narrow", "scaled"] as const) {
            test(`${layout}: connect inside Puzzles`, async ({
                page,
                mockScenario,
                assertNoHorizontalOverflow,
            }) => {
                await page.setViewportSize({
                    width: layout === "narrow" ? 320 : 1440,
                    height: 900,
                });
                await page.addInitScript(
                    (scale) => localStorage.setItem("font-size", String(scale)),
                    layout === "scaled" ? 200 : 100,
                );
                await mockScenario({
                    commands: {
                        ...commands,
                        chessriddle_training_next: {
                            outcomes: [{ error: "notConnected" }],
                            result: puzzle,
                        },
                    },
                });
                await page.goto("/");
                await page
                    .locator("[data-home-actions]")
                    .getByRole("button", { name: text("Home.Card.Puzzle.Title"), exact: true })
                    .click();
                const panel = page.locator("[data-training-panel]");
                await expect(panel.getByText(text("Training.ConnectPrompt"))).toBeVisible();
                await expect(
                    panel.getByRole("button", {
                        name: text("Home.ChessRiddle.Connect"),
                        exact: true,
                    }),
                ).toBeVisible();
                await assertControlLabelsFit(panel);
                await assertNoHorizontalOverflow();
                await panel.evaluate((node) => {
                    node.scrollTop = 0;
                });
                await expect(
                    panel.getByRole("radiogroup", {
                        name: text("Puzzle.Source.Label"),
                        exact: true,
                    }),
                ).toBeInViewport();
                await expect(
                    panel.getByRole("heading", { name: text("Training.Title"), exact: true }),
                ).toHaveCount(0);
                await expect(
                    panel.getByRole("button", { name: text("Training.Tactics"), exact: true }),
                ).toHaveCount(0);
                await expect(panel.locator('button[data-variant="filled"]')).toHaveCount(1);
                await expect(
                    panel.getByRole("button", { name: text("Training.TryAgain"), exact: true }),
                ).toHaveAttribute("data-variant", "default");
                const geometry = await panel.evaluate((node) => ({
                    scrollHeight: node.scrollHeight,
                    clientHeight: node.clientHeight,
                    scrollTop: node.scrollTop,
                }));
                const panelBox = (await panel.boundingBox())!;
                const connectBox = (await panel
                    .getByRole("button", { name: text("Home.ChessRiddle.Connect"), exact: true })
                    .boundingBox())!;
                console.log(
                    "CONNECT_PROMPT_GEOMETRY",
                    JSON.stringify({
                        locale,
                        layout,
                        ...geometry,
                        connectBottom: connectBox.y + connectBox.height - panelBox.y,
                    }),
                );
                if (layout === "desktop") {
                    expect(
                        geometry.scrollHeight,
                        `whole prompt must fit: ${JSON.stringify(geometry)}`,
                    ).toBeLessThanOrEqual(geometry.clientHeight + 1);
                }
                await captureTraining(page, page, `${locale}-${layout}-connect.png`);
                expect(await panel.evaluate((node) => node.scrollTop)).toBe(0);
                const owner = await activeWorkspaceTab(page);
                await panel
                    .getByRole("button", { name: text("Home.ChessRiddle.Connect"), exact: true })
                    .click();
                await expect(panel.getByText(text("Training.BlackToMove"))).toBeVisible();
                expect((await activeWorkspaceTab(page))!.value).toBe(owner!.value);
                const calls = await page.evaluate(() =>
                    window.__E2E_TAURI__
                        .invocations()
                        .filter((call) => call.command === "chessriddle_training_next"),
                );
                expect(calls).toHaveLength(2);
            });
            test(`${layout}: solving, verdict and tab ownership`, async ({
                page,
                mockScenario,
                assertNoHorizontalOverflow,
            }) => {
                await page.setViewportSize({
                    width: layout === "narrow" ? 320 : 1440,
                    height: 900,
                });
                await page.addInitScript(
                    (scale) => {
                        localStorage.setItem("font-size", JSON.stringify(scale));
                        localStorage.setItem("board-animation-speed", JSON.stringify("off"));
                    },
                    layout === "scaled" ? 200 : 100,
                );
                await mockScenario({ commands });
                await page.goto("/");
                const homeActions = page.locator("[data-home-actions]");
                await expect(homeActions.locator("[data-home-action]")).toHaveCount(5);
                const trainingButton = homeActions.getByRole("button", {
                    name: text("Home.Card.Puzzle.Title"),
                    exact: true,
                });
                if (layout !== "desktop") await trainingButton.scrollIntoViewIfNeeded();
                await expect(trainingButton).toBeVisible();
                await assertControlLabelsFit(homeActions);
                await assertNoHorizontalOverflow();
                await captureTraining(page, page, `${locale}-${layout}-home.png`);
                await trainingButton.click();
                const panel = page.locator("[data-training-panel]");
                await expect(panel.getByText(text("Training.BlackToMove"))).toBeVisible();
                const board = page.locator("#left cg-board");
                await expect(page.locator("#left .cg-wrap")).toHaveClass(/orientation-black/);
                await expect(board.locator("square.last-move")).toHaveCount(2);
                await expect(
                    panel.getByRole("button", { name: text("Training.Submit"), exact: true }),
                ).toBeDisabled();
                await assertControlLabelsFit(panel);
                await captureTraining(page, page, `${locale}-${layout}-solving.png`);
                await playTrainingMove(page, board, "e7", "e5");
                await playTrainingMove(page, board, "g1", "f3");
                await playTrainingMove(page, board, "b8", "c6");
                await page
                    .getByRole("button", { name: text("Training.FirstPosition"), exact: true })
                    .click();
                await playTrainingMove(page, board, "e7", "e5");
                expect(
                    await board
                        .locator("piece.black.pawn")
                        .evaluateAll((pieces) =>
                            pieces.some(
                                (piece) =>
                                    (piece as HTMLElement & { cgKey: string }).cgKey === "e7",
                            ),
                        ),
                ).toBe(true);
                await page
                    .getByRole("button", { name: text("Training.LastPosition"), exact: true })
                    .click();
                const owner = (await activeWorkspaceTab(page))!;
                await page.getByRole("button", { name: text("Tab.NewTab"), exact: true }).click();
                await page
                    .getByRole("tab", { name: text("Home.PuzzleTraining"), exact: true })
                    .click();
                await expect(
                    page.locator("#bottomRight").getByRole("button", { name: "Nc6", exact: true }),
                ).toBeVisible();
                // Returning to an overflowing tab can retain scrollIntoView's 4px inset scroll.
                // Capture the overview from the tab strip's start, as in the solving capture.
                const trainingTab = page.getByRole("tab", {
                    name: text("Home.PuzzleTraining"),
                    exact: true,
                });
                await trainingTab.evaluate((tab) => {
                    tab.closest(".mantine-ScrollArea-viewport")?.scrollTo({
                        left: 0,
                        behavior: "instant",
                    });
                });
                expect(
                    await trainingTab.evaluate(
                        (tab) => tab.closest(".mantine-ScrollArea-viewport")?.scrollLeft,
                    ),
                ).toBe(0);
                await panel
                    .getByRole("button", { name: text("Training.Submit"), exact: true })
                    .click();
                await expect(
                    panel.getByText(text("Training.Correct"), { exact: true }),
                ).toBeVisible();
                await expect(
                    page
                        .locator("#bottomRight")
                        .getByRole("heading", { name: text("Training.Solution"), exact: true }),
                ).toBeVisible();
                await page
                    .getByRole("button", { name: text("Training.NextPosition"), exact: true })
                    .click();
                await expect(page.locator("#left piece.black.pawn")).toHaveCount(8);
                await assertNoHorizontalOverflow();
                if (layout === "desktop") {
                    const next = (await panel
                        .getByRole("button", { name: text("Training.Next"), exact: true })
                        .boundingBox())!;
                    const bounds = (await panel.boundingBox())!;
                    expect(await panel.evaluate((element) => element.scrollTop)).toBe(0);
                    expect(next.y + next.height).toBeLessThan(bounds.y + bounds.height);
                }
                await captureTraining(page, page, `${locale}-${layout}-verdict.png`);
                const storedTree = await page.evaluate(
                    (id) => sessionStorage.getItem(id),
                    owner.value,
                );
                const tree = storedTree ? deserializeStorageValue(storedTree) : null;
                expect(JSON.stringify(tree)).not.toContain("correctVariation");
                expect(JSON.stringify(tree)).not.toContain("decisionFen");
                expect(owner).toMatchObject({ type: "puzzles", puzzleSource: "chessriddle" });
                const sent = await page.evaluate(() =>
                    window.__E2E_TAURI__
                        .invocations()
                        .filter((call) => call.command === "chessriddle_training_submit"),
                );
                expect(sent).toHaveLength(1);
                expect(sent[0].args).toMatchObject({
                    request: { line: ["e7e5", "g1f3", "b8c6"], solutionShown: false },
                });
                await preserveStorageForReload(page);
                await expect(
                    page
                        .locator("[data-training-panel]")
                        .getByRole("button", { name: text("Training.Submit"), exact: true }),
                ).toBeDisabled();
                await page.getByRole("button", { name: text("Tab.Close"), exact: true }).click();
                await expect(page.locator("[data-training-panel]")).toHaveCount(0);
            });
        }

        test("states and recovery at narrow width and enlarged fonts", async ({
            page,
            mockScenario,
            assertNoHorizontalOverflow,
        }) => {
            test.setTimeout(120_000);
            await page.setViewportSize({ width: 320, height: 900 });
            await page.addInitScript(() => localStorage.setItem("font-size", "200"));
            await mockScenario({
                commands: {
                    ...commands,
                    chessriddle_training_next: { result: puzzle, delay: 1200 },
                },
            });
            await page.goto("/");
            await page
                .locator("[data-home-actions]")
                .getByRole("button", { name: text("Home.Card.Puzzle.Title"), exact: true })
                .click();
            const panel = page.locator("[data-training-panel]");
            await expect(panel.getByText(text("Training.Loading"), { exact: true })).toBeVisible();
            await expect(
                panel.getByRole("button", { name: text("Training.ShowSolution"), exact: true }),
            ).toBeVisible();
            await assertControlLabelsFit(panel);
            const shortPuzzle = { ...puzzle, solutionPlyCount: 1 };
            await page.evaluate((commands) => window.__E2E_TAURI__.configure({ commands }), {
                ...commands,
                chessriddle_training_next: { result: shortPuzzle },
                chessriddle_training_submit: {
                    outcomes: [
                        {
                            result: {
                                ...verdict,
                                tooShort: true,
                                isCorrect: false,
                                correctVariation: [],
                                feedbackCode: "lineTooShort",
                            },
                        },
                        {
                            result: {
                                ...verdict,
                                isCorrect: false,
                                ratingChange: -8,
                                feedbackCode: "incorrect",
                            },
                        },
                    ],
                },
            });
            await panel
                .getByRole("button", { name: text("Training.Tactics"), exact: true })
                .click();
            const board = page.locator("#left cg-board");
            await playTrainingMove(page, board, "e7", "e5");
            await panel.getByRole("button", { name: text("Training.Submit"), exact: true }).click();
            await expect(panel.getByText(text("Training.TooShort"))).toBeVisible();
            await captureTraining(page, panel, `${locale}-too-short.png`);
            await playTrainingMove(page, board, "g1", "f3");
            await panel.getByRole("button", { name: text("Training.Submit"), exact: true }).click();
            await expect(
                panel.getByText(text("Training.Incorrect"), { exact: true }),
            ).toBeVisible();
            const submissions = await page.evaluate(() =>
                window.__E2E_TAURI__
                    .invocations()
                    .filter((call) => call.command === "chessriddle_training_submit")
                    .map((call) => (call.args as { request: { idempotencyKey: string } }).request),
            );
            expect(submissions[0].idempotencyKey).not.toBe(submissions[1].idempotencyKey);

            const errors: [AccountError, keyof typeof en.translation][] = [
                ["notConnected", "Training.ConnectPrompt"],
                ["invalidGrant", "Training.ConnectPrompt"],
                ["authentication", "Training.ConnectPrompt"],
                ["dailyLimit", "Training.Error.DailyLimit"],
                ["updateRequired", "Training.Error.UpdateRequired"],
                ["rateLimited", "Training.Error.RateLimited"],
                ["engineTimeout", "Training.Error.EngineTimeout"],
                ["engineBusy", "Training.Error.EngineBusy"],
                ["engineUnavailable", "Training.Error.EngineUnavailable"],
                ["network", "Training.Error.Network"],
                ["server", "Training.Error.Server"],
                ["submissionInProgress", "Training.Error.SubmissionInProgress"],
            ];
            for (const [error, key] of errors) {
                await page.evaluate(
                    ({ commands, puzzle, error }) =>
                        window.__E2E_TAURI__.configure({
                            commands: {
                                ...commands,
                                chessriddle_training_next: {
                                    result: { ...puzzle, source: "mistakes" },
                                },
                                chessriddle_training_submit: { error },
                            },
                        }),
                    { commands, puzzle, error },
                );
                const tryAgain = panel.getByRole("button", {
                    name: text("Training.TryAgain"),
                    exact: true,
                });
                if (await tryAgain.count()) await tryAgain.click();
                else await panel.getByRole("button", { name: /^(Mistakes|Fehler)/ }).click();
                await panel
                    .getByRole("button", { name: text("Training.ShowSolution"), exact: true })
                    .click();
                await expect(panel.getByText(text(key), { exact: true })).toBeVisible();
                await expect(
                    panel.getByRole("button", { name: text("Training.Submit"), exact: true }),
                ).toHaveCount(0);
                await assertControlLabelsFit(panel);
                if (
                    [
                        "engineBusy",
                        "engineUnavailable",
                        "network",
                        "server",
                        "rateLimited",
                        "submissionInProgress",
                    ].includes(error)
                ) {
                    await page.evaluate(
                        ({ commands, verdict }) =>
                            window.__E2E_TAURI__.configure({
                                commands: {
                                    ...commands,
                                    chessriddle_training_submit: {
                                        result: { ...verdict, rated: false, ratingPending: true },
                                    },
                                },
                            }),
                        { commands, verdict },
                    );
                    const before = await page.evaluate(
                        () =>
                            window.__E2E_TAURI__
                                .invocations()
                                .filter((call) => call.command === "chessriddle_training_submit")
                                .at(-1)?.args,
                    );
                    await panel
                        .getByRole("button", { name: text("Training.Retry"), exact: true })
                        .click();
                    await expect(panel.getByText(text("Training.Unrated"))).toBeVisible();
                    await expect(panel.getByText(text("Training.RatingPending"))).toBeVisible();
                    const after = await page.evaluate(
                        () =>
                            window.__E2E_TAURI__
                                .invocations()
                                .filter((call) => call.command === "chessriddle_training_submit")
                                .at(-1)?.args,
                    );
                    expect(after).toEqual(before);
                } else if (error === "engineTimeout") {
                    await expect(
                        panel.getByRole("button", { name: text("Training.Retry"), exact: true }),
                    ).toHaveCount(0);
                    await captureTraining(page, panel, `${locale}-engine-timeout.png`);
                    await page.evaluate(
                        (commands) => window.__E2E_TAURI__.configure({ commands }),
                        commands,
                    );
                    await panel
                        .getByRole("button", { name: text("Training.Next"), exact: true })
                        .click();
                    const next = await page.evaluate(
                        () =>
                            window.__E2E_TAURI__
                                .invocations()
                                .filter((call) => call.command === "chessriddle_training_next")
                                .at(-1)?.args,
                    );
                    expect(next).toMatchObject({ source: "mistakes", excludeIds: [puzzle.id] });
                } else if (error === "dailyLimit") {
                    await captureTraining(page, panel, `${locale}-daily-limit.png`);
                    await panel
                        .getByRole("button", { name: text("Training.Upgrade"), exact: true })
                        .click();
                    const upgrade = await page.evaluate(() =>
                        window.__E2E_TAURI__
                            .invocations()
                            .filter((call) => call.command === "chessriddle_open_upgrade"),
                    );
                    expect(upgrade).toHaveLength(1);
                    expect(upgrade[0].args).toEqual({});
                } else if (error === "notConnected") {
                    await expect(
                        panel.getByRole("button", {
                            name: text("Home.ChessRiddle.Connect"),
                            exact: true,
                        }),
                    ).toBeVisible();
                    await panel.evaluate((node) => {
                        node.scrollTop = 0;
                    });
                    await captureTraining(page, panel, `${locale}-not-connected.png`, false);
                    expect(await panel.evaluate((node) => node.scrollTop)).toBe(0);
                }
                await assertNoHorizontalOverflow();
            }
            await page.evaluate(
                (commands) =>
                    window.__E2E_TAURI__.configure({
                        commands: { ...commands, chessriddle_training_next: { result: null } },
                    }),
                commands,
            );
            await panel.getByRole("button", { name: /^(Mistakes|Fehler)/ }).click();
            await expect(panel.getByText(text("Training.NoMistakes"))).toBeVisible();
        });
    });
}
