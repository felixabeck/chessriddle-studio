import { activeWorkspaceTab, chooseBoardMoreAction, expect, playBoardMove, test } from "./fixtures";

const workspaceTabs = (page: import("@playwright/test").Page) =>
    page.locator("header [role='tablist'] [role='tab']");

// The replaced board gets a fresh identity, so the stored active tab id is what tells a
// replacement apart from nothing happening.
const storedActiveTab = async (page: import("@playwright/test").Page) =>
    (await activeWorkspaceTab(page))?.value;

test("new-analysis: More → New analysis replaces the board in the same tab, asking first about unsaved moves", async ({
    page,
}, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: /^Analysis Board$/ }).click();
    const board = page.locator("cg-board");
    await playBoardMove(page, board, "e2", "e4");
    await expect(page.getByRole("gridcell", { name: "e4, White Pawn", exact: true })).toHaveCount(
        1,
    );
    await expect(workspaceTabs(page)).toHaveCount(1);
    const firstBoard = await storedActiveTab(page);

    // The item leads the menu, with its shortcut beside it.
    await page.getByRole("button", { name: "More actions", exact: true }).click();
    const menu = page.getByRole("menu");
    const firstItem = menu.getByRole("menuitem").first();
    await expect(firstItem).toContainText("New analysis");
    await expect(firstItem).toContainText(/ctrl\s*\+\s*n/i);
    await expect(firstItem).toBeVisible();
    await expect(menu).toHaveCSS("opacity", "1");
    await page.screenshot({ path: testInfo.outputPath("more-menu.png") });
    await page.keyboard.press("Escape");

    // The unsaved move asks first, in the wording of starting anew rather than closing.
    await chooseBoardMoreAction(page, /^New analysis/);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("before starting a new analysis");
    await expect(
        dialog.getByRole("button", { name: "Save and start new", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("unsaved-dialog.png") });
    await dialog.getByRole("button", { name: "Start new without saving", exact: true }).click();

    // Same place in the tab strip, a fresh board at the start position.
    await expect(page.getByRole("gridcell", { name: "e2, White Pawn", exact: true })).toHaveCount(
        1,
    );
    await expect(page.getByRole("gridcell", { name: "e4, empty", exact: true })).toHaveCount(1);
    await expect(workspaceTabs(page)).toHaveCount(1);
    await expect(workspaceTabs(page).first()).toContainText("Analysis Board");
    await expect.poll(() => storedActiveTab(page)).not.toBe(firstBoard);
    const secondBoard = await storedActiveTab(page);
    await page.screenshot({ path: testInfo.outputPath("fresh-board.png") });

    // A clean board is replaced by the shortcut without asking. Chromium keeps Ctrl+N (like Ctrl+T
    // and Ctrl+W) for itself and never hands it to the page, so the key event is dispatched to the
    // document; the app's WebKitGTK window has no such reservation. A dialog still fading out owns
    // the keyboard, so the shortcut waits until it is gone.
    await expect(page.locator('[aria-modal="true"]')).toHaveCount(0);
    await page.evaluate(() =>
        document.body.dispatchEvent(
            new KeyboardEvent("keydown", {
                key: "n",
                code: "KeyN",
                ctrlKey: true,
                bubbles: true,
                cancelable: true,
            }),
        ),
    );
    await expect.poll(() => storedActiveTab(page)).not.toBe(secondBoard);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(workspaceTabs(page)).toHaveCount(1);
});
