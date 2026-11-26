import type { Page } from "@playwright/test";
import { expect, preserveStorageForReload, test, waitForTransitionsSettled } from "./fixtures";

async function openAnalysisBoard(page: Page) {
    await page.goto("/");
    await page.getByRole("button", { name: /^Analysis Board$/ }).click();
}

async function boardHeight(page: Page): Promise<number> {
    const box = await page.locator(".cg-wrap").first().boundingBox();
    if (!box) throw new Error("board not rendered");
    return box.height;
}

test("focus mode: the shortcut hides the header, the board takes its height, the top edge shows it again", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
}) => {
    await mockScenario({});
    // A wide window, where the board's height is the limit, as on a desktop monitor.
    await page.setViewportSize({ width: 1920, height: 900 });
    await openAnalysisBoard(page);

    const header = page.locator("header").first();
    const menuButton = page.getByRole("button", { name: "Application menu" });
    await expect(header).toBeInViewport();
    await expect(page.locator(".cg-wrap").first()).toBeVisible();
    const before = await boardHeight(page);

    await page.keyboard.press("Control+Shift+F");
    await expect(header).not.toBeInViewport();
    await expect.poll(() => boardHeight(page)).toBeGreaterThan(before + 20);
    await assertNoHorizontalOverflow();
    await expect(page).toHaveScreenshot("focus-mode-board.png");

    // The top edge brings the header back over the content; moving away hides it.
    await page.mouse.move(700, 2);
    await expect(header).toBeInViewport();
    await page.mouse.move(700, 400);
    await expect(header).not.toBeInViewport();

    // The revealed header's menu leaves focus mode.
    await page.mouse.move(700, 2);
    await expect(header).toBeInViewport();
    await menuButton.click();
    const showHeader = page.getByRole("menuitem", { name: "Show the header" });
    // The open menu keeps the header shown while the pointer is on the menu below it.
    await showHeader.hover();
    await waitForTransitionsSettled(page);
    await expect(header).not.toHaveAttribute("inert");
    await expect(header).toBeInViewport();
    await showHeader.click();
    await page.mouse.move(700, 400);
    await expect(header).toBeInViewport();
    await expect.poll(() => boardHeight(page)).toBeCloseTo(before, 0);
});

test("focus mode: full screen stays separate and focus mode is never remembered", async ({
    page,
    mockScenario,
}) => {
    await mockScenario({
        commands: {
            "plugin:window|is_fullscreen": { result: false },
            "plugin:window|set_fullscreen": { result: null },
        },
    });
    await openAnalysisBoard(page);
    const header = page.locator("header").first();
    const fullscreenCalls = () =>
        page.evaluate(
            () =>
                window.__E2E_TAURI__
                    .invocations()
                    .filter(({ command }) => command === "plugin:window|set_fullscreen").length,
        );

    // F11 toggles full screen and keeps the header.
    await page.keyboard.press("F11");
    await expect.poll(fullscreenCalls).toBe(1);
    await expect(header).toBeInViewport();

    await page.keyboard.press("Control+Shift+F");
    await expect(header).not.toBeInViewport();

    // F11 toggles full screen only; the header stays hidden until focus mode ends.
    await page.keyboard.press("F11");
    await expect.poll(fullscreenCalls).toBe(2);
    await expect(header).not.toBeInViewport();

    // Focus mode is never remembered: a reload starts with the header.
    await preserveStorageForReload(page);
    await expect(header).toBeInViewport();
});
