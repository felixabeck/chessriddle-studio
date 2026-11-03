import {
    expect,
    playBoardMove,
    preserveStorageForReload,
    test,
    whitePawnSquares,
} from "./fixtures";
import type { Page } from "@playwright/test";

/** Longer than the slow preset (400 ms), so an animation that would run has started and ended. */
const ANIMATION_WINDOW_MS = 700;

async function chooseAnimationSpeed(page: Page, label: string) {
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    const select = page.getByRole("textbox", { name: "Piece animation", exact: true });
    await select.scrollIntoViewIfNeeded();
    await select.click();
    await page.getByRole("option", { name: label, exact: true }).click();
    await expect(select).toHaveValue(label);
}

/** Steps one move and reports whether any board piece animated within the window. */
async function navigationAnimates(page: Page, step: "ArrowLeft" | "Next move") {
    const board = page.locator("cg-board").first();
    await board.evaluate((element) => {
        const marker = element as HTMLElement & { animated?: boolean };
        marker.animated = false;
        new MutationObserver((_records, observer) => {
            if (!element.querySelector("piece.anim")) return;
            marker.animated = true;
            observer.disconnect();
        }).observe(element, { subtree: true, attributes: true, attributeFilter: ["class"] });
    });
    if (step === "ArrowLeft") await page.keyboard.press(step);
    else await page.getByRole("button", { name: step, exact: true }).click();
    await page.waitForTimeout(ANIMATION_WINDOW_MS);
    // The step itself must have happened, or "no animation" would prove nothing.
    expect(await whitePawnSquares(board)).toContain(step === "ArrowLeft" ? "e2" : "e4");
    return board.evaluate((element) =>
        Boolean((element as HTMLElement & { animated?: boolean }).animated),
    );
}

for (const [label, stored, animates] of [
    ["Slow", "slow", true],
    ["Off", "off", false],
] as const) {
    test(`board-animation-speed: ${label} applies at once and after a reload`, async ({ page }) => {
        await page.goto("/");
        await page.getByRole("button", { name: /^open$/i }).click();
        const board = page.locator("cg-board").first();
        await expect(board).toBeVisible();
        await playBoardMove(page, board, "e2", "e4");
        await expect(page.getByText("1. e4")).toBeVisible();

        await chooseAnimationSpeed(page, label);
        await expect
            .poll(() => page.evaluate(() => localStorage.getItem("board-animation-speed")))
            .toBe(JSON.stringify(stored));
        await page.getByRole("link", { name: "Board", exact: true }).click();
        await expect(board).toBeVisible();
        expect(await navigationAnimates(page, "ArrowLeft")).toBe(animates);

        // After a reload the page has no keyboard focus here; the button runs the same navigation.
        await preserveStorageForReload(page);
        await expect(board).toBeVisible();
        expect(await navigationAnimates(page, "Next move")).toBe(animates);
    });
}
