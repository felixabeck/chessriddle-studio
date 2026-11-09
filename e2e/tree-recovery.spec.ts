import { expect, preserveStorageForReload, test } from "./fixtures";

test("tree-recovery: retains an unreadable play tab behind its recovery panel", async ({
    page,
    assertAccessible,
    assertNoHorizontalOverflow,
    capture,
}) => {
    await page.goto("/");
    await page.getByRole("button", { name: /^Analysis Board$/ }).click();
    await expect(page.getByRole("grid", { name: "Chessboard, White orientation" })).toBeVisible();

    const tabId = await page
        .locator("[data-rfd-drag-handle-draggable-id]")
        .first()
        .getAttribute("data-rfd-drag-handle-draggable-id");
    expect(tabId).toBeTruthy();
    const rawValue = "not a decodable tree";
    await page.evaluate(
        ({ id, raw }) => {
            sessionStorage.setItem(id, raw);
            const originalSetItem = Storage.prototype.setItem;
            Storage.prototype.setItem = function (key, value) {
                // Keep the deliberately seeded corrupt value from being replaced by the
                // current page's valid in-memory tree during its pagehide flush.
                if (key === id) return;
                originalSetItem.call(this, key, value);
            };
        },
        { id: tabId!, raw: rawValue },
    );
    await preserveStorageForReload(page);

    const recovery = page.locator('[data-tree-recovery="unreadable"]');
    await expect(recovery).toBeVisible();
    await expect(recovery).toContainText(
        "This tab's saved data may contain edits. Copy the exact saved value before discarding it; discarding starts a fresh board.",
    );
    await expect(recovery.getByRole("button", { name: "Copy saved value" })).toBeVisible();
    await expect(
        recovery.getByRole("button", { name: "Discard saved data and start fresh" }),
    ).toBeVisible();
    await expect(page.getByRole("grid")).toHaveCount(0);

    await page.getByRole("button", { name: "Close tab" }).click();
    await expect(page.getByRole("tab")).toHaveCount(1);
    await expect(recovery).toBeVisible();

    await preserveStorageForReload(page);
    await expect(page.locator('[data-tree-recovery="unreadable"]')).toBeVisible();
    await expect(page.getByRole("tab")).toHaveCount(1);
    await expect(page.getByRole("grid")).toHaveCount(0);
    await assertNoHorizontalOverflow();
    await assertAccessible();
    await capture("tree-recovery-unreadable");
    await expect(page).toHaveScreenshot("tree-recovery-unreadable.png", { fullPage: true });
});
