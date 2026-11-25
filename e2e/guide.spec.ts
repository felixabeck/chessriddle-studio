import { expect, scrollbarFreeScreenshot, test, waitForTransitionsSettled } from "./fixtures";
import { HELP_TOPIC_ORDER } from "../src/components/assistant/topics/order";

test("Help menu opens the Guide without an AI connection, switches topics, and follows links", async ({
    page,
    mockScenario,
    assertAccessible,
    assertNoHorizontalOverflow,
}, testInfo) => {
    await mockScenario({
        commands: {
            coach_available: { result: false },
        },
    });

    await page.goto("/");

    if (testInfo.project.name === "guide-scaled") {
        await expect
            .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).fontSize))
            .toBe("32px");
    }

    // No AI connection or Coach availability is needed to reach the Guide.
    await expect(page.getByRole("button", { name: "Assistant", exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Application menu", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Assistant", exact: true })).toHaveCount(0);

    const guideItem = page.getByRole("menuitem", { name: "Guide", exact: true });
    await expect(guideItem).toBeVisible();
    await guideItem.click();

    await expect(page.getByRole("heading", { name: "Guide", exact: true })).toBeVisible();

    const nav = page.getByRole("navigation");
    const guideTab = nav
        .locator('[data-page-tab="guide"]')
        .getByRole("button", { name: "Guide", exact: true });
    await expect(guideTab).toBeVisible();
    await expect(guideTab).toHaveAttribute("aria-current", "page");

    const firstTopicHeading = page.getByRole("heading", {
        name: "Tabs and the New tab page",
        exact: true,
    });
    await expect(firstTopicHeading).toBeVisible();

    await waitForTransitionsSettled(page);
    await assertNoHorizontalOverflow();
    await assertAccessible();
    await expect(page).toHaveScreenshot("guide-overview.png", {
        stylePath: scrollbarFreeScreenshot,
    });

    // Clicking the Next button advances to the second topic in HELP_TOPIC_ORDER.
    const secondTopicId = HELP_TOPIC_ORDER[1];
    const secondTopicTab = page.locator(`[role="tab"][data-topic-id="${secondTopicId}"]`);
    const secondTopicTitle = (await secondTopicTab
        .locator(".mantine-Tabs-tabLabel")
        .textContent())!;
    const nextButton = page
        .getByRole("tabpanel")
        .getByRole("button", { name: `Next: ${secondTopicTitle}`, exact: true });
    await nextButton.scrollIntoViewIfNeeded();
    await nextButton.click();
    await expect(page.getByRole("heading", { name: secondTopicTitle, exact: true })).toBeVisible();

    // Switching to another topic renders its body, suppresses unavailable target links to plain
    // text, and leaves available targets clickable.
    const aiTopicTab = page.getByRole("tab", { name: "Coach and AI connections", exact: true });
    await aiTopicTab.scrollIntoViewIfNeeded();
    await aiTopicTab.click();
    await expect(
        page.getByRole("heading", { name: "Coach and AI connections", exact: true }),
    ).toBeVisible();

    const panel = page.getByRole("tabpanel");
    await expect(panel).not.toContainText("[[");
    await expect(panel).not.toContainText("{{label:");
    await expect(panel.getByRole("button", { name: "AI", exact: true })).toHaveCount(0);
    await expect(panel).toContainText("Manage your connections in AI.");

    const enginesLink = panel.locator(
        '[data-testid="assistant-link"][data-target-id="page:engines"]',
    );
    await expect(enginesLink).toHaveText("Engines");

    await assertNoHorizontalOverflow();
    await assertAccessible();

    await enginesLink.click();
    await expect(page).toHaveURL(/\/engines$/);

    await guideTab.click();
    await expect(page).toHaveURL(/\/guide$/);
    await nav.getByRole("button", { name: "Close Guide", exact: true }).click();
    await expect(page).not.toHaveURL(/\/guide$/);
    await expect(page.getByRole("heading", { name: "Guide", exact: true })).toHaveCount(0);
    await expect(guideTab).toHaveCount(0);
});
