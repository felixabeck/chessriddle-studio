import {
    test,
    expect,
    filesWorkspaceCommands,
    gameOpeningCommands,
    gameOpeningFixture,
} from "./fixtures";

test("selecting a game row, pressing F2, editing Event, and pressing Enter updates the list row", async ({
    page,
    mockScenario,
}) => {
    const original = gameOpeningFixture.games[0];
    const updated = {
        ...original,
        event: "Candidates 2026",
        stamp: "d".repeat(64),
    };
    const initialList = { data: gameOpeningFixture.games, count: gameOpeningFixture.games.length };
    const updatedList = {
        data: [updated, ...gameOpeningFixture.games.slice(1)],
        count: gameOpeningFixture.games.length,
    };

    await mockScenario({
        commands: filesWorkspaceCommands([[]], {
            ...gameOpeningCommands,
            get_games: {
                results: [initialList],
                result: updatedList,
            },
            get_db_game: { result: { kind: "found", game: original } },
            write_db_game_headers: { result: updated.stamp },
        }),
    });

    await page.goto(`/databases/${gameOpeningFixture.databaseId}`);

    const firstRow = page.getByRole("row").filter({ hasText: original.white });
    await expect(firstRow).toContainText(original.event);
    await firstRow.click();

    await page.keyboard.press("F2");

    const dialog = page.getByRole("dialog", { name: "Edit game data", exact: true });
    await expect(dialog).toBeVisible();

    const eventField = dialog.getByRole("textbox", { name: "Event", exact: true });
    await expect(eventField).toHaveValue(original.event);
    await eventField.fill("Candidates 2026");
    await eventField.press("Enter");

    await expect(dialog).toHaveCount(0);
    await expect(firstRow).toContainText("Candidates 2026");

    const writes = await page.evaluate(() =>
        window.__E2E_TAURI__
            .invocations()
            .filter((item) => item.command === "write_db_game_headers"),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.args).toMatchObject({
        gameId: original.id,
        expectedStamp: original.stamp,
        headers: expect.objectContaining({ event: "Candidates 2026" }),
    });
});
