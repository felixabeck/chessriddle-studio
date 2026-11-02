import {
    test,
    expect,
    filesWorkspaceCommands,
    gameOpeningCommands,
    gameOpeningFixture,
    playBoardMove,
} from "./fixtures";

test("a refused database save shows recovery actions and reload restores the board", async ({
    page,
    mockScenario,
}) => {
    await page.addInitScript(() => localStorage.setItem("auto-save", "false"));
    const game = gameOpeningFixture.games[0];
    await mockScenario({
        commands: filesWorkspaceCommands([[]], {
            ...gameOpeningCommands,
            get_db_game: { result: { kind: "found", game } },
            write_db_game: {
                error: {
                    tag: "backend-error",
                    category: "stale-game",
                    message: "The game changed in the database",
                },
            },
        }),
    });
    await page.goto(`/databases/${gameOpeningFixture.databaseId}`);
    await page.getByRole("row").filter({ hasText: game.white }).dblclick();
    await expect(page).toHaveURL("/");
    const board = page.locator("cg-board").first();
    await expect(board).toBeVisible();
    await playBoardMove(page, board, "g1", "f3");
    await page.getByRole("button", { name: /^Save PGN/ }).click();
    await expect(
        page.getByText("This game changed in the database while you were editing.", {
            exact: true,
        }),
    ).toBeVisible();
    await expect(board).toHaveCount(0);
    const viewport = page.viewportSize()!;
    for (const name of ["Reload from database", "Save my version as a new game…"]) {
        const button = page.getByRole("button", { name, exact: true });
        await expect(button).toBeVisible();
        await expect(button).toBeEnabled();
        const box = (await button.boundingBox())!;
        expect(box).not.toBeNull();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    }
    await page.screenshot({ path: "test-results/database-conflict-panel.png" });
    await page.getByRole("button", { name: "Reload from database", exact: true }).click();
    await expect(board).toBeVisible();
    await expect(page.locator("[data-file-freshness]")).toHaveAttribute(
        "data-file-freshness",
        /^verified:/,
    );
});
