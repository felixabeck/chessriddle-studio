import {
    test,
    expect,
    activeWorkspaceTab,
    assertNothingClipped,
    databaseCommands,
    filesWorkspaceCommands,
    gameOpeningFixture,
    pgnFileCommands,
    playBoardMove,
    selectFilesTreeRow,
    waitForScrollAreaScrollbarsHidden,
} from "./fixtures";

const repertoireFile = {
    ...gameOpeningFixture.file,
    name: "Weiß_Caro Kann",
    metadata: { type: "repertoire" as const, tags: [] },
    gameCount: 1,
};

const savedWrite = {
    stamp: "b".repeat(64),
    revision: "saved-generation",
};

function repertoireCommands() {
    return filesWorkspaceCommands([[repertoireFile]], {
        ...pgnFileCommands,
        ...databaseCommands(gameOpeningFixture.databaseId, "opening.db3", {
            title: gameOpeningFixture.databaseTitle,
            description: "Two distinct games",
            game_count: 2,
            player_count: 4,
            event_count: 2,
            storage_size: "4096",
            indexed: false,
        }),
        count_pgn_games: { result: repertoireFile.gameCount },
        write_game: { result: savedWrite },
        list_file_workspace: {
            results: [
                { entries: [repertoireFile], unread: [] },
                { entries: [repertoireFile], unread: [] },
            ],
            result: { entries: [repertoireFile], unread: [] },
        },
    });
}

test("Library New game opens a fileDraft and appends on explicit save", async ({
    page,
    mockScenario,
}) => {
    await page.addInitScript(() => localStorage.setItem("auto-save", "false"));
    await mockScenario({ commands: repertoireCommands() });
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    await selectFilesTreeRow(page, repertoireFile.name);
    const newGame = page.getByRole("button", { name: "New game", exact: true });
    await expect(newGame).toBeEnabled();
    await newGame.scrollIntoViewIfNeeded();
    await waitForScrollAreaScrollbarsHidden(page);
    await assertNothingClipped(page.locator("main"));
    await expect(page).toHaveScreenshot("file-new-game.png");
    await newGame.click();
    await expect(page).toHaveURL("/");
    expect((await activeWorkspaceTab(page))?.gameOrigin).toEqual({
        kind: "fileDraft",
        file: {
            type: "file",
            handle: repertoireFile.handle,
            name: repertoireFile.name,
            numGames: repertoireFile.gameCount,
            metadata: repertoireFile.metadata,
            lastModified: repertoireFile.lastModified,
        },
    });
    const writes = () =>
        page.evaluate(() =>
            window.__E2E_TAURI__.invocations().filter((item) => item.command === "write_game"),
        );
    expect(await writes()).toHaveLength(0);
    await playBoardMove(page, page.locator("cg-board").first(), "e2", "e4");
    expect(await writes()).toHaveLength(0);
    await page.getByRole("button", { name: /^Save PGN/ }).click();
    await expect
        .poll(async () => (await activeWorkspaceTab(page))?.gameOrigin)
        .toMatchObject({
            kind: "file",
            gameNumber: repertoireFile.gameCount,
            file: { handle: repertoireFile.handle, metadata: { type: "repertoire" } },
        });
    expect(await writes()).toMatchObject([
        {
            command: "write_game",
            args: {
                file: repertoireFile.handle,
                n: repertoireFile.gameCount,
                expected: { kind: "append" },
            },
        },
    ]);
});

test("Save to file or database appends to a repertoire file and rebinds the tab", async ({
    page,
    mockScenario,
    assertAccessible,
}) => {
    await page.addInitScript(() => localStorage.setItem("auto-save", "false"));
    await mockScenario({ commands: repertoireCommands() });
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    await selectFilesTreeRow(page, repertoireFile.name);
    await page.getByRole("link", { name: "Board", exact: true }).click();
    await page.getByRole("button", { name: /^Analysis Board$/ }).click();
    await playBoardMove(page, page.locator("cg-board").first(), "e2", "e4");
    await page.getByRole("button", { name: "Save to file or database…", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "Save to file or database…", exact: true });
    await modal.getByRole("textbox", { name: "File or database", exact: true }).click();
    await expect(page.getByRole("option", { name: repertoireFile.name })).toBeVisible();
    await expect(
        page.getByRole("option", { name: gameOpeningFixture.databaseTitle, exact: true }),
    ).toBeVisible();
    await page.getByRole("option", { name: repertoireFile.name }).click();
    await expect(modal.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    await assertNothingClipped(modal);
    await assertAccessible();
    await expect(page).toHaveScreenshot("save-to-file-or-database-modal.png");
    await modal.getByRole("button", { name: "Save", exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect(page.getByText(`Saved to ${repertoireFile.name}.`, { exact: true })).toBeVisible();
    await expect
        .poll(async () => (await activeWorkspaceTab(page))?.gameOrigin)
        .toMatchObject({
            kind: "file",
            gameNumber: repertoireFile.gameCount,
            file: { handle: repertoireFile.handle, metadata: { type: "repertoire" } },
        });
    const writes = await page.evaluate(() =>
        window.__E2E_TAURI__.invocations().filter((item) => item.command === "write_game"),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
        command: "write_game",
        args: {
            file: repertoireFile.handle,
            n: repertoireFile.gameCount,
            expected: { kind: "append" },
        },
    });
});
