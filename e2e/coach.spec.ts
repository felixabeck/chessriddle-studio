import type {
    ConnectionSummary,
    ModelList,
    TurnInput,
    TurnUpdate,
} from "../src/bindings/generated";
import {
    expect,
    playBoardMove,
    seedAnalysisEngines,
    test,
    waitForTransitionsSettled,
    type MockScenario,
} from "./fixtures";

const connection: ConnectionSummary = {
    handle: "coach-connection",
    kind: "api",
    label: "Local model",
    address: "http://localhost:11434/v1",
    hasKey: false,
    status: "ready",
};
const models: ModelList = {
    models: [
        {
            id: "coach-model",
            name: "Coach model",
            effortLevels: [],
            defaultEffort: null,
            supportsTools: true,
        },
    ],
    truncated: false,
};
const answer: TurnUpdate = {
    type: "completed",
    segments: [
        { type: "text", text: "Black usually answers in the centre with " },
        { type: "line", san: ["e5", "Nf3", "Nc6"], uci: ["e7e5", "g1f3", "b8c6"] },
        { type: "text", text: " and fights for **d4**.\n\nThe Sicilian " },
        { type: "line", san: ["c5"], uci: ["c7c5"] },
        { type: "text", text: " is the sharper choice." },
    ],
    failedLines: 0,
};
const TURN = "coach-turn-1";

const commands: NonNullable<MockScenario["commands"]> = {
    coach_available: { result: true },
    coach_connections: { result: [connection] },
    coach_models: { result: models },
    prepare_analysis: { result: TURN },
    cancel_analysis: { result: null },
    // The native reply arrives long after the turn's own events ended it.
    coach_turn: { result: answer, delay: 30_000 },
};

test("ask the Coach, read the streamed answer, preview a line and insert it", async ({
    page,
    mockScenario,
    emitTauriEvent,
    assertAccessible,
}) => {
    await mockScenario({ commands });
    await seedAnalysisEngines(page, [
        { id: "coach-engine", name: "Coach Stockfish", handleId: "coach-engine-handle" },
    ]);
    await page.goto("/");
    await page.getByRole("button", { name: /^Analysis Board$/ }).click();
    await playBoardMove(page, page.locator("cg-board").first(), "e2", "e4");
    await page.getByRole("tab", { name: "Coach", exact: true }).click();

    // The only connection is chosen without a click; the hint names the missing model. The
    // selectors sit behind the model button beside Send.
    const modelButton = page.getByRole("button", { name: /^AI model: / });
    await expect(modelButton).toHaveText("Choose a model");
    await expect(modelButton).toHaveAccessibleName("AI model: Local model · Choose a model");
    const hint = page.getByText("Choose a model to ask a question.");
    await expect(hint).toBeVisible();
    await modelButton.click();
    await expect(page.getByRole("textbox", { name: "Connection" })).toHaveValue("Local model");
    await page.getByRole("textbox", { name: "Model" }).click();
    await page.getByRole("option", { name: "Coach model" }).click();
    await expect(page.getByRole("textbox", { name: "Effort" })).toHaveValue("Provider default");
    await expect(hint).toHaveCount(0);
    await expect(modelButton).toHaveText("Coach model");
    await expect(modelButton).toHaveAccessibleName("AI model: Local model · Coach model");
    await waitForTransitionsSettled(page);
    await expect(page.getByRole("dialog")).toHaveScreenshot("coach-model-popover.png");

    const composer = page.getByRole("textbox", { name: "Ask the Coach" });
    // A click outside closes the popover.
    await composer.click();
    await expect(page.getByRole("textbox", { name: "Effort" })).toHaveCount(0);
    await composer.fill("What should Black play here?");
    // With a question typed, Send is the primary action on the composer's toolbar line.
    await waitForTransitionsSettled(page);
    await expect(page.locator("form").filter({ has: composer })).toHaveScreenshot(
        "coach-composer-ready.png",
    );
    await composer.press("Enter");

    // Nothing is sent before the notice for this connection was accepted.
    const notice = page.getByRole("dialog", { name: "Before you send" });
    await expect(notice).toContainText("are sent to Local model");
    expect(
        await page.evaluate(() =>
            window.__E2E_TAURI__.invocations().some(({ command }) => command === "coach_turn"),
        ),
    ).toBe(false);
    await notice.getByRole("button", { name: "Send", exact: true }).click();

    let sent: { id: string; tab: string; turn: TurnInput } | undefined;
    await expect
        .poll(async () => {
            sent = await page.evaluate(
                () =>
                    window.__E2E_TAURI__
                        .invocations()
                        .find(({ command }) => command === "coach_turn")?.args as never,
            );
            return sent?.id;
        })
        .toBe(TURN);
    expect(sent!.turn).toMatchObject({
        connection: "coach-connection",
        model: "coach-model",
        message: "What should Black play here?",
        moves: ["e2e4"],
        engineId: "coach-engine",
    });
    expect(sent!.turn.game).toContain("1. e4");
    const turnEvent = (update: TurnUpdate) =>
        emitTauriEvent({
            event: "coach-turn-event",
            payload: { tab: sent!.tab, turn: TURN, update },
        });

    const running = page.getByTestId("coach-running");
    await expect(running).toContainText("Thinking…");
    await turnEvent({ type: "tool", source: "engine", line: ["e5", "Nf3"] });
    await expect(running).toContainText("The engine is checking e5 Nf3");
    await turnEvent({ type: "text", delta: "Black usually answers " });
    await turnEvent({ type: "text", delta: "in the centre" });
    await expect(running).toContainText("Black usually answers in the centre");
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();

    await turnEvent(answer);
    await expect(running).toHaveCount(0);
    const shown = page.getByTestId("coach-answer");
    await expect(shown).toContainText("and fights for d4.");
    await expect(shown.locator("strong")).toHaveText("d4");
    const lines = shown.getByTestId("coach-line");
    await expect(lines).toHaveCount(2);
    // Numbered from the position the question was asked about: Black's first move.
    await expect(lines.first()).toContainText("1...");
    await expect(lines.first()).toContainText("2.");

    await waitForTransitionsSettled(page);
    await assertAccessible();
    await expect(page.locator("#topRight")).toHaveScreenshot("coach-answer.png");

    // A move of a Coach line only previews: the game keeps its single move.
    const notation = page.locator("#bottomRight");
    await lines.first().getByText("c6").click();
    await expect(page.getByTestId("engine-line-preview")).toBeVisible();
    await expect(notation).not.toContainText("e5");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("engine-line-preview")).toHaveCount(0);

    // The insert button is the one way a line gets into the game.
    await lines.first().getByRole("button", { name: "Insert as variation" }).click();
    await expect(notation).toContainText("e5");
    await expect(notation).toContainText("f3");
    await expect(notation).toContainText("c6");
});

test("Settings → AI holds the model the Coach and the Assistant answer with", async ({
    page,
    mockScenario,
    assertAccessible,
}) => {
    await mockScenario({ commands });
    await page.goto("/settings");
    await page.getByRole("tab", { name: "AI", exact: true }).click();

    const row = page.locator('[data-setting-id="coach-model"]');
    await expect(row).toContainText("The Coach and the Assistant answer with this model");
    await expect(row.getByRole("textbox", { name: "Connection" })).toHaveValue("Local model");
    await row.getByRole("textbox", { name: "Model" }).click();
    await page.getByRole("option", { name: "Coach model" }).click();
    await expect(row.getByRole("textbox", { name: "Effort" })).toHaveValue("Provider default");

    // The choice is the one the Coach's model button shows.
    expect(
        await page.evaluate(() => JSON.parse(localStorage.getItem("coach-selection") ?? "null")),
    ).toEqual({ connection: "coach-connection", model: "coach-model", effort: null });

    await waitForTransitionsSettled(page);
    await assertAccessible();
    await expect(row).toHaveScreenshot("settings-ai-model.png");

    // An effort picked from the list is stored with the same choice.
    await row.getByRole("textbox", { name: "Effort" }).click();
    await page.getByRole("option", { name: "High" }).click();
    await expect(row.getByRole("textbox", { name: "Effort" })).toHaveValue("High");
    expect(
        await page.evaluate(() => JSON.parse(localStorage.getItem("coach-selection") ?? "null")),
    ).toEqual({ connection: "coach-connection", model: "coach-model", effort: "high" });
});
