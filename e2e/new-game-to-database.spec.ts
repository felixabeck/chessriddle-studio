import {
    test,
    expect,
    activeWorkspaceTab,
    assertNothingClipped,
    filesWorkspaceCommands,
    gameOpeningCommands,
    gameOpeningFixture,
    playBoardMove,
    selectFilesTreeRow,
    waitForScrollAreaScrollbarsHidden,
} from "./fixtures";
import type { Locator } from "@playwright/test";

// The board can report no box right after navigating to it (f-20261030-21). A stub board whose
// first measurements are null proves playBoardMove waits for geometry instead of dereferencing it.
test("playBoardMove waits for a measured board box", async ({ page }) => {
    const measured = { x: 0, y: 0, width: 800, height: 800 };
    const boxes = [null, null, measured];
    const clicks: unknown[] = [];
    const board = {
        click: async (options?: { trial?: boolean; position?: { x: number; y: number } }) => {
            if (!options?.trial) clicks.push(options?.position);
        },
        boundingBox: async () => (boxes.length > 0 ? boxes.shift() : measured),
    } as unknown as Locator;

    await playBoardMove(page, board, "e2", "e4");

    expect(clicks).toEqual([
        { x: 450, y: 650 },
        { x: 450, y: 450 },
    ]);
});

test("New game inserts on explicit save, updates that row, and Save to database rebinds", async ({
    page,
    mockScenario,
    assertAccessible,
}) => {
    await page.addInitScript(() => localStorage.setItem("auto-save", "false"));
    await mockScenario({
        commands: filesWorkspaceCommands([[]], {
            ...gameOpeningCommands,
            insert_db_game: {
                results: [
                    { id: 501, stamp: "a".repeat(64) },
                    { id: 502, stamp: "b".repeat(64) },
                ],
            },
            write_db_game: { result: "c".repeat(64) },
        }),
    });
    await page.goto("/library");
    await selectFilesTreeRow(page, gameOpeningFixture.databaseTitle);
    const newGame = page.getByRole("button", { name: "New game", exact: true });
    await expect(newGame).toBeEnabled();
    await newGame.scrollIntoViewIfNeeded();
    await waitForScrollAreaScrollbarsHidden(page);
    await assertNothingClipped(page.locator("main"));
    await expect(page).toHaveScreenshot("database-new-game.png");
    await newGame.click();
    await expect(page).toHaveURL("/");
    expect((await activeWorkspaceTab(page))?.gameOrigin).toEqual({
        kind: "databaseDraft",
        database: { id: { id: gameOpeningFixture.databaseId }, kind: "database" },
    });
    const board = page.locator("cg-board").first();
    await playBoardMove(page, board, "e2", "e4");
    const saves = () =>
        page.evaluate(() =>
            window.__E2E_TAURI__
                .invocations()
                .filter((item) => ["insert_db_game", "write_db_game"].includes(item.command)),
        );
    expect(await saves()).toHaveLength(0);
    await page.getByRole("button", { name: /^Save PGN/ }).click();
    await expect
        .poll(async () => (await activeWorkspaceTab(page))?.gameOrigin)
        .toMatchObject({ kind: "database", gameId: 501 });
    await playBoardMove(page, board, "e7", "e5");
    await page.getByRole("button", { name: /^Save PGN/ }).click();
    await expect
        .poll(async () => (await saves()).map((item) => item.command))
        .toEqual(["insert_db_game", "write_db_game"]);
    await page.getByRole("button", { name: "Save to database…", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "Save to database…", exact: true });
    await modal.getByRole("textbox", { name: "Database", exact: true }).click();
    await page.getByRole("option", { name: gameOpeningFixture.databaseTitle, exact: true }).click();
    await assertNothingClipped(modal);
    await assertAccessible();
    await expect(page).toHaveScreenshot("save-to-database-modal.png");
    await modal.getByRole("button", { name: "Save", exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect(
        page.getByText(`Saved to ${gameOpeningFixture.databaseTitle}.`, { exact: true }),
    ).toBeVisible();
    await expect
        .poll(async () => (await activeWorkspaceTab(page))?.gameOrigin)
        .toMatchObject({ kind: "database", gameId: 502 });
    await expect(page.getByRole("button", { name: /^Save PGN/ })).toHaveAttribute(
        "data-variant",
        "transparent",
    );
    expect(await saves()).toHaveLength(3);
    await expect(page).toHaveScreenshot("saved-to-database.png");
});

test("linked collection New game appends to its PGN without inserting into the index", async ({
    page,
    mockScenario,
}) => {
    await page.addInitScript(() => localStorage.setItem("auto-save", "false"));
    const file = { ...gameOpeningFixture.file, metadata: { type: "game", tags: [] } };
    const database = { id: { id: gameOpeningFixture.databaseId }, kind: "database" };
    const collection = {
        id: "22222222-2222-4222-8222-222222222222",
        name: file.name,
        file: file.handle,
        database,
        account: null,
        status: "ready",
        generation: "linked-generation",
        omitted: 0,
        retiredDatabase: null,
        fetchSinceMs: null,
    };
    const appendedGame = {
        pgn: '[Result "*"]\n\n1. e4 *',
        present: true,
        stamp: "b".repeat(64),
        revision: "saved-generation",
        linked: {
            collection: collection.id,
            ordinal: 2,
            stamp: "b".repeat(64),
            generation: "saved-generation",
        },
    };
    const pgnGames = [...(gameOpeningCommands.read_game.pgnGames ?? []), appendedGame];
    await mockScenario({
        commands: filesWorkspaceCommands([[file]], {
            ...gameOpeningCommands,
            read_game: { pgnGames },
            read_games: { pgnGames },
            // Exercise reconciliation once, then keep later polls at the saved revision.
            file_revision: {
                results: ["opening-fixture-revision"],
                result: appendedGame.revision,
            },
            list_workspace_databases: { result: { entries: [], unread: [] } },
            linked_collections_supported: { result: true },
            list_linked_collections: { result: [collection] },
            collection_for_database: { result: collection },
            count_pgn_games: { result: 2 },
            write_game: {
                result: {
                    stamp: "b".repeat(64),
                    revision: "saved-generation",
                    linked: {
                        collection: collection.id,
                        ordinal: 2,
                        stamp: "b".repeat(64),
                        generation: "saved-generation",
                    },
                },
            },
        }),
    });
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose collection", exact: true }).click();
    await selectFilesTreeRow(page, file.name);
    await expect(page.getByRole("button", { name: "New game", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "New game", exact: true }).scrollIntoViewIfNeeded();
    await waitForScrollAreaScrollbarsHidden(page);
    await expect(page).toHaveScreenshot("linked-new-game.png");
    await page.getByRole("button", { name: "New game", exact: true }).click();
    await expect(page).toHaveURL("/");
    await playBoardMove(page, page.locator("cg-board").first(), "e2", "e4");
    await page.getByRole("button", { name: /^Save PGN/ }).click();
    await expect
        .poll(async () => (await activeWorkspaceTab(page))?.gameOrigin)
        .toMatchObject({ kind: "file", gameNumber: 2, file: { handle: file.handle } });
    const savedAt = Date.now();
    await expect
        .poll(async () => {
            const reconciled = await page.evaluate(() =>
                window.__E2E_TAURI__
                    .invocations()
                    .some(
                        (item) =>
                            item.command === "read_game" && (item.args as { n?: number }).n === 2,
                    ),
            );
            return reconciled && Date.now() - savedAt > 2_000;
        })
        .toBe(true);
    await expect(
        page.getByText("Cannot read properties of undefined", { exact: false }),
    ).toHaveCount(0);
    await expect(page.locator("[data-file-freshness]")).toHaveAttribute(
        "data-file-freshness",
        /^verified:/,
    );
    await expect(page.getByRole("button", { name: /^Save PGN/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Save PGN/ })).toHaveAttribute(
        "data-variant",
        "transparent",
    );
    const writes = await page.evaluate(() =>
        window.__E2E_TAURI__
            .invocations()
            .filter((item) => ["write_game", "insert_db_game"].includes(item.command)),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
        command: "write_game",
        args: { file: file.handle, n: 2, expected: { kind: "append" } },
    });
});
