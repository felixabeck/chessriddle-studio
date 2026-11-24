import type {
    AssistantTurnInput,
    AssistantTurnUpdate,
    ConnectionSummary,
    ModelList,
} from "../src/bindings/generated";
import { expect, test, waitForTransitionsSettled, type MockScenario } from "./fixtures";

const connection: ConnectionSummary = {
    handle: "assistant-connection",
    kind: "api",
    label: "Local model",
    address: "http://localhost:11434/v1",
    hasKey: false,
    status: "ready",
};

const models: ModelList = {
    models: [
        {
            id: "assistant-model",
            name: "Assistant model",
            effortLevels: [],
            defaultEffort: null,
            supportsTools: true,
        },
    ],
    truncated: false,
};

const DRAFT_MESSAGE = "Please add a keyboard shortcut to toggle the Assistant panel.";

const answer: AssistantTurnUpdate = {
    type: "completed",
    segments: [
        { type: "text", text: "You can adjust text scaling under " },
        { type: "link", target: "setting:font-size" },
        { type: "text", text: ".\n\nIf something is missing, open " },
        { type: "link", target: "feedback" },
        { type: "text", text: " to send a note." },
    ],
    feedbackDraft: {
        feedbackType: "suggestion",
        message: DRAFT_MESSAGE,
    },
};

const commands: NonNullable<MockScenario["commands"]> = {
    coach_available: { result: true },
    coach_has_connection: { result: true },
    coach_connections: { result: [connection] },
    coach_models: { result: models },
    // The native reply arrives long after the turn's own events ended it.
    assistant_turn: { result: answer, delay: 30_000 },
};

test("ask the Assistant, follow a setting link, and open prefilled feedback", async ({
    page,
    mockScenario,
    emitTauriEvent,
    assertAccessible,
}, testInfo) => {
    const isNarrow = testInfo.project.name === "assistant-narrow";

    await mockScenario({ commands });
    await page.goto("/");

    const toggleButton = page.getByRole("button", { name: "Assistant", exact: true });
    await expect(toggleButton).toBeVisible();
    await toggleButton.click();

    const panel = page.getByTestId("assistant-panel");
    await expect(panel).toBeVisible();
    if (isNarrow) {
        await expect(panel).toHaveAttribute("data-overlay", "true");
    } else {
        await expect(panel).not.toHaveAttribute("data-overlay", "true");
    }

    // The only connection is selected automatically; choose the model behind the model button.
    const modelButton = panel.getByRole("button", { name: /^AI model: / });
    await modelButton.click();
    await expect(page.getByRole("textbox", { name: "Connection" })).toHaveValue("Local model");
    await page.getByRole("textbox", { name: "Model" }).click();
    await page.getByRole("option", { name: "Assistant model" }).click();
    await expect(modelButton).toHaveText("Assistant model");

    const composer = panel.getByRole("textbox", { name: "Ask the Assistant" });
    await composer.click();
    await expect(page.getByRole("textbox", { name: "Effort" })).toHaveCount(0);
    await composer.fill("Where can I change the font size?");
    await composer.press("Enter");

    // Nothing is sent before the Assistant's own notice is accepted.
    const notice = page.getByRole("dialog", { name: "Before you send" });
    await expect(notice).toContainText("are sent to Local model");
    expect(
        await page.evaluate(() =>
            window.__E2E_TAURI__.invocations().some(({ command }) => command === "assistant_turn"),
        ),
    ).toBe(false);
    await notice.getByRole("button", { name: "Send", exact: true }).click();

    let sent: { id: string; ticket: string; turn: AssistantTurnInput } | undefined;
    await expect
        .poll(async () => {
            sent = await page.evaluate(
                () =>
                    window.__E2E_TAURI__
                        .invocations()
                        .find(({ command }) => command === "assistant_turn")?.args as never,
            );
            return sent?.id;
        })
        .toBeTruthy();
    expect(sent!.turn).toMatchObject({
        connection: "assistant-connection",
        model: "assistant-model",
        message: "Where can I change the font size?",
    });
    expect(sent!.turn.topics.length).toBeGreaterThan(0);
    expect(sent!.turn.settings.length).toBeGreaterThan(0);
    expect(sent!.turn.targets.some((t) => t.id === "setting:font-size")).toBe(true);

    const turnEvent = (update: AssistantTurnUpdate) =>
        emitTauriEvent({
            event: "assistant-turn-event",
            payload: { turn: sent!.id, update },
        });

    const running = panel.getByTestId("assistant-running");
    await expect(running).toContainText("Thinking…");
    await turnEvent({ type: "readingTopics", topics: ["settings-appearance"] });
    await expect(running).toContainText("Reading help topics…");
    await turnEvent({ type: "text", delta: "You can adjust text scaling" });
    await expect(running).toContainText("You can adjust text scaling");

    await turnEvent(answer);
    await expect(running).toHaveCount(0);

    const shown = panel.getByTestId("assistant-answer");
    const links = shown.getByTestId("assistant-link");
    await expect(links).toHaveCount(2);
    await expect(links.nth(0)).toHaveText("Font Size");
    await expect(links.nth(1)).toHaveText("Send feedback");

    await waitForTransitionsSettled(page);
    await assertAccessible();
    await expect(page).toHaveScreenshot("assistant-answer.png");

    // Clicking the setting link opens Settings on Appearance with Font size marked.
    await links.nth(0).click();
    if (isNarrow) {
        await panel.getByRole("button", { name: "Close Assistant" }).click();
        await expect(panel).toHaveCount(0);
    }
    const markedRow = page.locator('[data-setting-id="font-size"]');
    await expect(markedRow).toBeVisible();
    await expect(markedRow).toHaveAttribute("data-highlighted", "true");

    if (!isNarrow) {
        await expect(panel).toBeVisible();
        await waitForTransitionsSettled(page);
        await assertAccessible();
        await expect(page).toHaveScreenshot("assistant-settings-link.png");

        // Clicking the feedback link opens the feedback form prefilled with the draft.
        await links.nth(1).click();
        const feedbackDialog = page.getByRole("dialog", { name: "Send feedback" });
        await expect(feedbackDialog).toBeVisible();
        await expect(feedbackDialog.getByRole("radio", { name: "Suggestion" })).toBeChecked();
        await expect(feedbackDialog.getByRole("textbox", { name: "Message" })).toHaveValue(
            DRAFT_MESSAGE,
        );
        await waitForTransitionsSettled(page);
        await assertAccessible();
        await expect(feedbackDialog).toHaveScreenshot("assistant-feedback-prefilled.png");
    }
});
