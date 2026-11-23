import {
    expect,
    goToBoards,
    goToSettings,
    playBoardMove,
    test,
    waitForTransitionsSettled,
} from "./fixtures";
import type { Page } from "@playwright/test";

async function openBoard(page: Page) {
    await page.goto("/");
    await page.getByRole("button", { name: /^Analysis Board$/ }).click();
    const board = page.locator("cg-board").first();
    await expect(board).toBeVisible();
    return board;
}

async function openBoardSettings(page: Page) {
    await goToSettings(page);
    await page.getByRole("tab", { name: "Board", exact: true }).click();
    const colorInput = page.getByRole("textbox", { name: "Move Highlight Color", exact: true });
    await expect(colorInput).toBeVisible();
    return colorInput;
}

test("board-last-move-highlight: the real stylesheet paints the chosen colour and opacity on the last move", async ({
    page,
}) => {
    const board = await openBoard(page);
    await playBoardMove(page, board, "e2", "e4");
    const lastMove = board.locator("square.last-move");
    await expect(lastMove).toHaveCount(2);
    for (const square of await lastMove.all()) {
        await expect(square).toHaveCSS("background-color", "rgba(255, 255, 0, 0.4)");
    }
    // The highlight is the same in both colour schemes; no scheme-specific rule overrides it.
    await page.evaluate(() =>
        document.documentElement.setAttribute("data-mantine-color-scheme", "dark"),
    );
    for (const square of await lastMove.all()) {
        await expect(square).toHaveCSS("background-color", "rgba(255, 255, 0, 0.4)");
    }
    await page.evaluate(() =>
        document.documentElement.setAttribute("data-mantine-color-scheme", "light"),
    );

    const colorInput = await openBoardSettings(page);
    await expect(colorInput).toHaveValue("#ffff00");
    await colorInput.fill("#0095FF");
    await expect
        .poll(() => page.evaluate(() => localStorage.getItem("last-move-highlight-color")))
        .toBe('"#0095ff"');
    const opacity = page.getByRole("slider", { name: "Move Highlight Opacity", exact: true });
    await opacity.focus();
    await opacity.press("ArrowRight");
    await expect
        .poll(() => page.evaluate(() => localStorage.getItem("last-move-highlight-opacity")))
        .toBe("45");

    await goToBoards(page);
    await expect(lastMove).toHaveCount(2);
    for (const square of await lastMove.all()) {
        await expect(square).toHaveCSS("background-color", "rgba(0, 149, 255, 0.45)");
    }
});

test("board-last-move-highlight: the Board settings with the highlight controls pass the accessibility scan", async ({
    page,
    assertAccessible,
}) => {
    await page.goto("/settings");
    await openBoardSettings(page);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await waitForTransitionsSettled(page);
    await assertAccessible();
});
