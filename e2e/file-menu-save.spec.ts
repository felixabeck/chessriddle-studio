import type { Page } from "@playwright/test";
import { activeWorkspaceTab, expect, openApplicationMenu, test } from "./fixtures";

async function openFileMenu(page: Page) {
    await openApplicationMenu(page);
}

const saveToDialog = (page: Page) =>
    page.getByRole("dialog", { name: "Save to file or database…", exact: true });

test("File menu lists Save and Save to file or database… between Open File and Exit", async ({
    page,
}) => {
    await page.goto("/");
    await openFileMenu(page);
    const save = page.getByRole("menuitem", { name: /^Save/ });
    await expect(save).toHaveCount(2);
    await expect(save.nth(0)).toContainText("Save");
    await expect(save.nth(0)).toContainText("ctrl+s", { ignoreCase: true });
    await expect(save.nth(1)).toContainText("Save to file or database…");
});

test("File → Save to file or database… opens the dialog of the active analysis tab", async ({
    page,
}) => {
    await page.goto("/");
    await page.getByRole("button", { name: /^Analysis Board$/ }).click();
    expect((await activeWorkspaceTab(page))?.type).toBe("analysis");
    await openFileMenu(page);
    await page.getByRole("menuitem", { name: "Save to file or database…" }).click();
    await expect(saveToDialog(page)).toBeVisible();
});

test("File → Save to file or database… does nothing without an analysis tab", async ({ page }) => {
    await page.goto("/");
    expect((await activeWorkspaceTab(page))?.type).toBe("new");
    await openFileMenu(page);
    await page.getByRole("menuitem", { name: "Save to file or database…" }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(saveToDialog(page)).toHaveCount(0);
});
