import type { Page } from "@playwright/test";
import {
    test,
    expect,
    activeWorkspaceTab,
    assertNothingClipped,
    chooseBoardMoreAction,
    databaseCommands,
    filesWorkspaceCommands,
    gameOpeningFixture,
    pgnFileCommands,
    playBoardMove,
    selectFilesTreeRow,
    scrollbarFreeScreenshot,
    seedBoardLayouts,
    goToBoards,
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
        // Native file_revision reports the written generation after an append. Only file tabs
        // poll it and neither test has one before its save, so the saved revision is the only
        // answer the 2 s freshness poll may see; a stale one shows "different game" on slow runs.
        file_revision: { result: savedWrite.revision },
        list_file_workspace: {
            results: [
                { entries: [repertoireFile], unread: [] },
                { entries: [repertoireFile], unread: [] },
            ],
            result: { entries: [repertoireFile], unread: [] },
        },
    });
}

/**
 * Waits until the app's 2 s file revision poll has read the bound file twice — a second read
 * starts only after the first one's outcome was applied — and asserts the tab still shows its
 * board. A stale revision would reconcile the tab against the fixture game and replace the board
 * with the "different game" panel, but only on a run slow enough to reach the poll.
 */
async function expectBoundTabSurvivesRevisionPoll(page: Page) {
    const revisionReads = () =>
        page.evaluate(
            () =>
                window.__E2E_TAURI__
                    .invocations()
                    .filter((item) => item.command === "file_revision").length,
        );
    await expect.poll(revisionReads, { timeout: 8_000 }).toBeGreaterThan(1);
    await expect(page.getByText("The file now has a different game at this position.")).toHaveCount(
        0,
    );
    await expect(page.locator("cg-board").first()).toBeVisible();
}

test("Library New game opens a fileDraft, asks for the line name and appends on explicit save", async ({
    page,
    mockScenario,
    assertAccessible,
}) => {
    await seedBoardLayouts(page);
    await page.addInitScript(() => localStorage.setItem("auto-save", "false"));
    await mockScenario({ commands: repertoireCommands() });
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    await selectFilesTreeRow(page, repertoireFile.name);
    const newGame = page.getByRole("button", { name: "New game", exact: true });
    await expect(newGame).toBeEnabled();
    await newGame.scrollIntoViewIfNeeded();
    await assertNothingClipped(page.locator("main"));
    await expect(page).toHaveScreenshot("file-new-game.png", {
        stylePath: scrollbarFreeScreenshot,
    });
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
    // An unnamed line shows a muted title that opens the same naming dialog.
    await expect(page.getByRole("button", { name: "Untitled line", exact: true })).toBeVisible();
    await page.getByRole("button", { name: /^Save PGN/ }).click();
    const naming = page.getByRole("dialog", { name: "Save line", exact: true });
    await expect(naming.getByRole("textbox", { name: "Line name", exact: true })).toBeFocused();
    expect(await writes()).toHaveLength(0);
    await naming.getByRole("textbox", { name: "Line name", exact: true }).fill("Two Knights");
    await naming.getByRole("textbox", { name: "Idea", exact: true }).fill("3...Bg4");
    await assertNothingClipped(naming);
    await assertAccessible();
    await expect(page).toHaveScreenshot("file-new-game-name-dialog.png");
    await naming
        .getByRole("button", { name: `Save to ${repertoireFile.name}`, exact: true })
        .click();
    await expect(naming).toHaveCount(0);
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
    const [written] = await writes();
    expect(written?.args.pgn).toContain('[White "Two Knights"]');
    expect(written?.args.pgn).toContain('[Black "3...Bg4"]');
    expect((await activeWorkspaceTab(page))?.name).toBe("Two Knights");
    await expectBoundTabSurvivesRevisionPoll(page);
    await expect(page.getByRole("button", { name: "Two Knights", exact: true })).toBeVisible();
});

test("Save a copy appends to a repertoire file and rebinds the tab", async ({
    page,
    mockScenario,
    assertAccessible,
}) => {
    await seedBoardLayouts(page);
    await page.addInitScript(() => localStorage.setItem("auto-save", "false"));
    await mockScenario({ commands: repertoireCommands() });
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    await selectFilesTreeRow(page, repertoireFile.name);
    await goToBoards(page);
    await page.getByRole("button", { name: /^Analysis Board$/ }).click();
    await playBoardMove(page, page.locator("cg-board").first(), "e2", "e4");
    await chooseBoardMoreAction(page, /^Save a copy…/);
    const modal = page.getByRole("dialog", { name: "Save a copy…", exact: true });
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
    await expectBoundTabSurvivesRevisionPoll(page);
});

test("Save a copy targeting the tab's own file updates the existing game in place", async ({
    page,
    mockScenario,
}) => {
    await seedBoardLayouts(page);
    await page.addInitScript(() => localStorage.setItem("auto-save", "false"));
    await mockScenario({ commands: repertoireCommands() });
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    await selectFilesTreeRow(page, repertoireFile.name);
    await page.getByRole("button", { name: "Open game", exact: true }).click();
    await expect(page).toHaveURL("/");
    await expect
        .poll(async () => (await activeWorkspaceTab(page))?.gameOrigin)
        .toMatchObject({
            kind: "file",
            gameNumber: 0,
            file: { handle: repertoireFile.handle },
        });

    await playBoardMove(page, page.locator("cg-board").first(), "e2", "e4");
    await chooseBoardMoreAction(page, /^Save a copy…/);
    const modal = page.getByRole("dialog", { name: "Save a copy…", exact: true });
    await modal.getByRole("textbox", { name: "File or database", exact: true }).click();
    await page.getByRole("option", { name: repertoireFile.name }).click();
    await expect(
        modal.getByText("This is the current game. Saving will update it.", { exact: true }),
    ).toBeVisible();
    const updateButton = modal.getByRole("button", { name: "Update this game", exact: true });
    await expect(updateButton).toBeEnabled();
    await updateButton.click();
    await expect(modal).toHaveCount(0);
    await expect(page.getByText(`Saved to ${repertoireFile.name}.`, { exact: true })).toBeVisible();

    const writes = await page.evaluate(() =>
        window.__E2E_TAURI__.invocations().filter((item) => item.command === "write_game"),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
        command: "write_game",
        args: {
            file: repertoireFile.handle,
            n: 0,
            expected: { kind: "game", stamp: expect.any(String) },
        },
    });
});
