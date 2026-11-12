import { test, expect, filesWorkspaceCommands } from "./fixtures";

test.beforeEach(async ({ mockScenario }) => {
    await mockScenario({
        commands: filesWorkspaceCommands([[]], {
            verify_signed_bytes: { result: null },
            issue_pgn_workspace: {
                error: {
                    tag: "backend-error",
                    category: "invalid-input",
                    message: "Export the ChessBase database as PGN first",
                    chessBaseDatabase: true,
                },
            },
        }),
    });
});

test("empty Library opens the migration guide with reachable content", async ({
    page,
    assertNoHorizontalOverflow,
}, testInfo) => {
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    await expect(page.getByText("Your library is empty.", { exact: false })).toBeVisible();
    const link = page.getByRole("button", { name: "Coming from ChessBase?", exact: true });
    await expect(link).toHaveScreenshot("guide-entry.png");
    await link.click();
    const modal = page.getByRole("dialog", { name: "Coming from ChessBase?" });
    await expect(modal).toBeVisible();
    if (testInfo.project.name === "chessbase-guide-scaled") {
        await expect
            .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).fontSize))
            .toBe("32px");
    }
    const title = modal.getByRole("heading", { name: "Coming from ChessBase?" });
    await title.scrollIntoViewIfNeeded();
    await expect(title).toBeInViewport();
    await expect(
        modal.getByText("This file is a ChessBase database.", { exact: false }),
    ).toHaveCount(0);
    await assertNoHorizontalOverflow();
    await expect(modal).toHaveScreenshot("guide-top.png");
    const lastTip = modal.getByText("Comments, variations, symbols", { exact: false });
    await lastTip.scrollIntoViewIfNeeded();
    await expect(lastTip).toBeInViewport();
    await assertNoHorizontalOverflow();
    await expect(modal).toHaveScreenshot("guide-tips.png");
    const close = modal.getByRole("button", { name: "Close dialog" });
    await close.scrollIntoViewIfNeeded();
    await expect(close).toBeInViewport();
    await close.click();
    await expect(modal).toHaveCount(0);
});

test("picker rejection and native drop open selected-file guidance", async ({
    page,
    emitTauriEvent,
}) => {
    await page.goto("/library");
    await page.getByRole("button", { name: "Import or download database", exact: true }).click();
    const add = page.getByRole("dialog");
    await add.getByRole("tab", { name: "Local", exact: true }).click();
    await add.getByRole("button", { name: "Coming from ChessBase?", exact: true }).click();
    let guide = page.getByRole("dialog", { name: "Coming from ChessBase?" });
    await expect(guide).toBeVisible();
    await expect(
        guide.getByText("This file is a ChessBase database.", { exact: false }),
    ).toHaveCount(0);
    await guide.getByRole("button", { name: "Close dialog" }).click();
    await add.getByRole("button", { name: "PGN file", exact: true }).click();
    guide = page.getByRole("dialog", { name: "Coming from ChessBase?" });
    await expect(
        guide.getByText("This file is a ChessBase database.", { exact: false }),
    ).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await guide.getByRole("button", { name: "Close dialog" }).click();
    await emitTauriEvent({ event: "chess-base-selected", payload: {} });
    await expect(
        guide.getByText("This file is a ChessBase database.", { exact: false }),
    ).toBeVisible();
    expect(
        await page.evaluate(() =>
            window.__E2E_TAURI__
                .invocations()
                .filter(({ command }) => ["count_pgn_games", "convert_pgn"].includes(command)),
        ),
    ).toEqual([]);
});
