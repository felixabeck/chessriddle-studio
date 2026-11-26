import type {
    AssistantTurnInput,
    AssistantTurnUpdate,
    ConnectionSummary,
    ModelList,
} from "../src/bindings/generated";
import {
    expect,
    preserveStorageForReload,
    test,
    waitForTransitionsSettled,
    type MockScenario,
} from "./fixtures";

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

    // Clicking the setting link opens Settings on General with Font Size marked.
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

test("resize the Assistant dock by mouse and keyboard, clamp limits, reset, persist, and omit handle in overlay", async ({
    page,
    mockScenario,
    assertAccessible,
}, testInfo) => {
    const isNarrow = testInfo.project.name === "assistant-narrow";

    await mockScenario({ commands });

    if (isNarrow) {
        await page.addInitScript(() => {
            window.localStorage.setItem("assistant-dock-width", "34");
        });
        await page.goto("/");

        await page.getByRole("button", { name: "Assistant", exact: true }).click();
        const panel = page.getByTestId("assistant-panel");
        await expect(panel).toBeVisible();
        await expect(panel).toHaveAttribute("data-overlay", "true");
        await expect(panel.getByRole("separator")).toHaveCount(0);

        const panelBox = await panel.boundingBox();
        const viewport = page.viewportSize()!;
        expect(panelBox).not.toBeNull();
        expect(Math.abs(panelBox!.width - viewport.width)).toBeLessThanOrEqual(2);
        expect(await page.evaluate(() => window.localStorage.getItem("assistant-dock-width"))).toBe(
            "34",
        );
        return;
    }

    await page.goto("/");
    const openAssistant = async () => {
        await page.getByRole("button", { name: "Assistant", exact: true }).click();
        const panel = page.getByTestId("assistant-panel");
        await expect(panel).toBeVisible();
        return panel;
    };

    const panel = await openAssistant();
    const handle = panel.getByRole("separator", { name: "Resize Assistant" });
    await expect(handle).toBeVisible();

    const widthOf = async () => (await panel.boundingBox())!.width;
    const viewportWidth = page.viewportSize()!.width;
    const maxPx = viewportWidth * 0.42;
    const minPx = 20 * 16;
    const defaultPx = 24 * 16;

    expect(Math.abs((await widthOf()) - defaultPx)).toBeLessThanOrEqual(2);

    const dragBy = async (deltaX: number) => {
        const box = (await handle.boundingBox())!;
        const startX = box.x + box.width / 2;
        const startY = box.y + box.height / 2;
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(startX + deltaX, startY, { steps: 6 });
        await page.mouse.up();
    };

    // Drag left by 160px (10rem) -> 34rem (544px).
    await dragBy(-160);
    const widened = await widthOf();
    expect(Math.abs(widened - (defaultPx + 160))).toBeLessThanOrEqual(3);
    const storedAfterDrag = Number(
        await page.evaluate(() => window.localStorage.getItem("assistant-dock-width")),
    );
    expect(Math.abs(storedAfterDrag - 34)).toBeLessThanOrEqual(0.25);

    await waitForTransitionsSettled(page);
    await assertAccessible();
    await expect(page).toHaveScreenshot("assistant-resized-dock.png");

    // Reload keeps the remembered width.
    await preserveStorageForReload(page);
    await openAssistant();
    expect(Math.abs((await widthOf()) - widened)).toBeLessThanOrEqual(2);

    // Drag past the upper limit (42vw) and lower limit (20rem), asserting stored values are clamped too.
    await dragBy(-500);
    expect(Math.abs((await widthOf()) - maxPx)).toBeLessThanOrEqual(2);
    const storedAtMax = Number(
        await page.evaluate(() => window.localStorage.getItem("assistant-dock-width")),
    );
    expect(storedAtMax).toBeLessThanOrEqual(Math.round((maxPx / 16) * 100) / 100);
    expect(storedAtMax).toBeGreaterThanOrEqual(Math.round((maxPx / 16) * 100) / 100 - 0.1);

    await dragBy(600);
    expect(Math.abs((await widthOf()) - minPx)).toBeLessThanOrEqual(2);
    expect(await page.evaluate(() => window.localStorage.getItem("assistant-dock-width"))).toBe(
        "20",
    );

    // At the 20rem floor the composer's toolbar keeps the model button, New conversation and Send
    // on one line, in that order, inside the panel.
    const toolbarBoxes = await Promise.all(
        [
            panel.getByRole("button", { name: /^AI model: / }),
            panel.getByRole("button", { name: "New conversation", exact: true }),
            panel.getByRole("button", { name: "Send", exact: true }),
        ].map(async (control) => (await control.boundingBox())!),
    );
    const panelRight = (await panel.boundingBox())!.x + minPx;
    const centreY = (box: { y: number; height: number }) => box.y + box.height / 2;
    for (const [index, box] of toolbarBoxes.entries()) {
        expect(Math.abs(centreY(box) - centreY(toolbarBoxes[0]))).toBeLessThanOrEqual(2);
        expect(box.x + box.width).toBeLessThanOrEqual(panelRight);
        if (index > 0) {
            const previous = toolbarBoxes[index - 1];
            expect(previous.x + previous.width).toBeLessThanOrEqual(box.x);
        }
    }

    // Keyboard resize from the floor: ArrowRight stays clamped at 20rem; two ArrowLeft widen by 3rem (48px), one ArrowRight narrows by 1.5rem (24px).
    await handle.focus();
    await handle.press("ArrowRight");
    expect(await page.evaluate(() => window.localStorage.getItem("assistant-dock-width"))).toBe(
        "20",
    );
    await handle.press("ArrowLeft");
    await handle.press("ArrowLeft");
    expect(Math.abs((await widthOf()) - (minPx + 48))).toBeLessThanOrEqual(2);
    await handle.press("ArrowRight");
    expect(Math.abs((await widthOf()) - (minPx + 24))).toBeLessThanOrEqual(2);
    expect(await page.evaluate(() => window.localStorage.getItem("assistant-dock-width"))).toBe(
        "21.5",
    );

    // Double-click resets to 24rem.
    await handle.dblclick();
    expect(Math.abs((await widthOf()) - defaultPx)).toBeLessThanOrEqual(2);
    expect(await page.evaluate(() => window.localStorage.getItem("assistant-dock-width"))).toBe(
        "24",
    );

    // Out-of-range stored values are clamped visually and left untouched in storage.
    await page.evaluate(() => window.localStorage.setItem("assistant-dock-width", "10"));
    await preserveStorageForReload(page);
    await openAssistant();
    expect(Math.abs((await widthOf()) - minPx)).toBeLessThanOrEqual(2);
    expect(await page.evaluate(() => window.localStorage.getItem("assistant-dock-width"))).toBe(
        "10",
    );

    await page.evaluate(() => window.localStorage.setItem("assistant-dock-width", "90"));
    await preserveStorageForReload(page);
    await openAssistant();
    expect(Math.abs((await widthOf()) - maxPx)).toBeLessThanOrEqual(2);
    expect(await page.evaluate(() => window.localStorage.getItem("assistant-dock-width"))).toBe(
        "90",
    );
});
