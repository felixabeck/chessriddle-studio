import {
    test,
    expect,
    activeWorkspaceTab,
    assertNothingClipped,
    chooseBoardMoreAction,
    filesWorkspaceCommands,
    gameOpeningCommands,
    gameOpeningFixture,
    playBoardMove,
    selectFilesTreeRow,
    scrollbarFreeScreenshot,
    waitForFontsSettled,
} from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import type { MockScenario } from "./fixtures";

// The board can report no box right after navigating to it (f-20261030-21). A stub board whose
// first measurements are null proves playBoardMove waits for geometry instead of dereferencing it.
test("playBoardMove waits for a measured board box", async ({ page }) => {
    const measured = { x: 0, y: 0, width: 800, height: 800 };
    const boxes = [null, null, measured];
    const clicks: unknown[] = [];
    const board = {
        and: () => board,
        count: async () => 1,
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

async function mountViewOnlyBoardStub(page: Page) {
    await page.setContent(`
        <style>
            cg-board { display: block; width: 192px; height: 192px; }
            .manipulable cg-board { width: 552px; height: 552px; }
        </style>
        <div class="cg-wrap"><cg-board id="preview"></cg-board></div>
        <ol id="clicks"></ol>
    `);
    await page.evaluate(() => {
        document.addEventListener("click", (event) => {
            const board = (event.target as Element).closest("cg-board");
            if (!board) return;
            const box = board.getBoundingClientRect();
            const click = document.createElement("li");
            click.textContent = JSON.stringify({
                board: board.id,
                x: event.clientX - box.x,
                y: event.clientY - box.y,
            });
            document.getElementById("clicks")!.appendChild(click);
        });
    });
}

test("playBoardMove waits for the caller's view-only board to be replaced by an interactive board", async ({
    page,
}) => {
    await mountViewOnlyBoardStub(page);
    await page.evaluate(() => {
        setTimeout(() => {
            const interactive = document.createElement("div");
            interactive.className = "cg-wrap manipulable";
            interactive.innerHTML = '<cg-board id="interactive"></cg-board>';
            document.querySelector(".cg-wrap")!.replaceWith(interactive);
        }, 1_000);
    });

    await playBoardMove(page, page.locator("cg-board").first(), "e2", "e4");

    const clicks = await page
        .locator("#clicks li")
        .evaluateAll((clicks) => clicks.map((click) => JSON.parse(click.textContent!)));
    expect(clicks.map((click) => click.board)).toEqual(["interactive", "interactive"]);
    for (const [index, y] of [448.5, 310.5].entries()) {
        // Mouse event coordinates can round to an integer CSS pixel.
        expect(Math.abs(clicks[index].x - 310.5)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(clicks[index].y - y)).toBeLessThanOrEqual(0.5);
    }
});

test("playBoardMove rejects a board that stays view-only without clicking it", async ({ page }) => {
    test.setTimeout(20_000);
    await mountViewOnlyBoardStub(page);

    await expect(playBoardMove(page, page.locator("cg-board").first(), "e2", "e4")).rejects.toThrow(
        "The board stayed view-only instead of becoming interactive",
    );

    await expect(page.locator("#clicks li")).toHaveCount(0);
});

test("New game inserts on explicit save, updates that row, and Save a copy to the same database updates in place", async ({
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
    await assertNothingClipped(page.locator("main"));
    await expect(page).toHaveScreenshot("database-new-game.png", {
        stylePath: scrollbarFreeScreenshot,
    });
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
    // The first save of a new game asks for its players and event before inserting.
    const naming = page.getByRole("dialog", { name: "Save game", exact: true });
    await expect(naming.getByRole("textbox", { name: "White", exact: true })).toBeFocused();
    expect(await saves()).toHaveLength(0);
    await naming.getByRole("textbox", { name: "White", exact: true }).fill("Carlsen");
    await naming.getByRole("textbox", { name: "Black", exact: true }).fill("Nakamura");
    await naming.getByRole("button", { name: "Save", exact: true }).click();
    await expect(naming).toHaveCount(0);
    await expect
        .poll(async () => (await activeWorkspaceTab(page))?.gameOrigin)
        .toMatchObject({ kind: "database", gameId: 501 });
    expect((await saves())[0]?.args).toMatchObject({
        pgn: expect.stringContaining('[White "Carlsen"]'),
    });
    expect((await activeWorkspaceTab(page))?.name).toBe("Carlsen - Nakamura");
    await playBoardMove(page, board, "e7", "e5");
    await page.getByRole("button", { name: /^Save PGN/ }).click();
    await expect
        .poll(async () => (await saves()).map((item) => item.command))
        .toEqual(["insert_db_game", "write_db_game"]);
    await chooseBoardMoreAction(page, /^Save a copy…/);
    const modal = page.getByRole("dialog", { name: "Save a copy…", exact: true });
    await modal.getByRole("textbox", { name: "File or database", exact: true }).click();
    await page.getByRole("option", { name: gameOpeningFixture.databaseTitle, exact: true }).click();
    await expect(
        modal.getByText("This is the current game. Saving will update it.", { exact: true }),
    ).toBeVisible();
    const updateButton = modal.getByRole("button", { name: "Update this game", exact: true });
    await expect(updateButton).toBeEnabled();
    await assertNothingClipped(modal);
    await assertAccessible();
    await expect(page).toHaveScreenshot("save-to-database-modal.png");
    await updateButton.click();
    await expect(modal).toHaveCount(0);
    await expect(
        page.getByText(`Saved to ${gameOpeningFixture.databaseTitle}.`, { exact: true }),
    ).toBeVisible();
    await expect
        .poll(async () => (await activeWorkspaceTab(page))?.gameOrigin)
        .toMatchObject({ kind: "database", gameId: 501 });
    await expect(page.getByRole("button", { name: /^Save PGN/ })).toHaveCount(0);
    expect((await saves()).map((item) => item.command)).toEqual([
        "insert_db_game",
        "write_db_game",
        "write_db_game",
    ]);
    await expect(page).toHaveScreenshot("saved-to-database.png");
});

test("Autosave on a database game shows Saving then Saved in the board bar without a toast", async ({
    page,
    mockScenario,
}) => {
    await mockScenario({
        commands: filesWorkspaceCommands([[]], {
            ...gameOpeningCommands,
            write_db_game: { result: "d".repeat(64), delay: 400 },
        }),
    });
    await page.goto("/library");
    await selectFilesTreeRow(page, gameOpeningFixture.databaseTitle);
    await page.getByRole("button", { name: "Open database", exact: true }).click();
    await expect(page).toHaveURL(`/databases/${gameOpeningFixture.databaseId}`);
    await page.getByRole("row").filter({ hasText: gameOpeningFixture.games[0].white }).dblclick();
    await expect(page).toHaveURL("/");
    await expect
        .poll(async () => (await activeWorkspaceTab(page))?.gameOrigin)
        .toMatchObject({ kind: "database", gameId: gameOpeningFixture.games[0].id });

    const topBar = page.locator('[data-board-bar="above"]');
    await expect(topBar.getByText("Saved", { exact: true })).toBeVisible();

    await page.getByRole("tab", { name: "Info", exact: true }).click();
    const eventField = page.getByLabel("Event", { exact: true });
    await eventField.fill("Club Championship");
    await expect(topBar.getByText("Saving…", { exact: true })).toBeVisible();
    await expect(topBar.getByText("Saved", { exact: true })).toBeVisible();
    await expect(page.locator(".mantine-Notification-root")).toHaveCount(0);
    await assertNothingClipped(topBar);
    await waitForFontsSettled(page);
    await expect(topBar).toHaveScreenshot("board-bar-autosave-saved.png");
});

async function openNewGameInfo(
    page: Page,
    mockScenario: (scenario: MockScenario) => Promise<void>,
) {
    await page.addInitScript(() => localStorage.setItem("auto-save", "false"));
    await mockScenario({ commands: filesWorkspaceCommands([[]], gameOpeningCommands) });
    await page.goto("/library");
    await selectFilesTreeRow(page, gameOpeningFixture.databaseTitle);
    await page.getByRole("button", { name: "New game", exact: true }).click();
    await page.getByRole("tab", { name: "Info", exact: true }).click();
}

test("Tab from White Elo opens the result list with a visible focus outline", async ({
    page,
    mockScenario,
}) => {
    await openNewGameInfo(page, mockScenario);
    const whiteElo = page.getByLabel("White Elo", { exact: true });
    await whiteElo.fill("2077");
    await page.keyboard.press("Tab");
    const result = page.getByLabel("Result", { exact: true });
    await expect(result).toBeFocused();
    await expect(result).toHaveAttribute("aria-expanded", "true");
    // Same ring as the neighbouring fields (`GameInfo.module.css` focus-visible rule).
    expect(
        await result.evaluate((element) => {
            const style = getComputedStyle(element);
            return [style.outlineStyle, style.outlineWidth, style.outlineOffset];
        }),
    ).toEqual(["solid", "3px", "2px"]);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await expect(result).toHaveValue("1/2-1/2");
    await expect(result).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Black Elo", { exact: true })).toBeFocused();
    await expect(result).toHaveValue("1/2-1/2");
    await expect(result).toHaveAttribute("aria-expanded", "false");
});

// The date field once had a fixed 4.5rem width that cut off the last digit of "2007.03.25".
test("the Info date field shows a full date and the placeholder without clipping", async ({
    page,
    mockScenario,
}) => {
    await openNewGameInfo(page, mockScenario);
    // The width is calibrated to the bundled Inter; measure only once it has replaced the fallback.
    await waitForFontsSettled(page);
    const date = page.getByLabel("Date", { exact: true });
    const fits = () => date.evaluate((element) => element.scrollWidth <= element.clientWidth);
    // The centre column (site and date), so a date that fits its own box but pushes past the
    // column is caught too.
    const centre = date.locator("xpath=ancestor::div[contains(@class, 'mantine-Group-root')][1]");

    await expect(date).toHaveAttribute("placeholder", "????.??.??");
    expect(await fits()).toBe(true);

    await date.fill("2007.03.25");
    await page.keyboard.press("Tab");
    await expect(date).toHaveValue("2007.03.25");
    await waitForFontsSettled(page);
    expect(await fits()).toBe(true);
    await assertNothingClipped(centre);

    // An editable Site grows with its text, but never past the centre column.
    const site = page.getByLabel("Site", { exact: true });
    await site.fill("Saint Louis Chess Club, Missouri, United States of America");
    const [siteBox, centreBox] = await Promise.all([site.boundingBox(), centre.boundingBox()]);
    expect(siteBox!.x + siteBox!.width).toBeLessThanOrEqual(centreBox!.x + centreBox!.width + 1);
    expect(siteBox!.x).toBeGreaterThanOrEqual(centreBox!.x - 1);
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
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    await selectFilesTreeRow(page, file.name);
    await expect(page.getByRole("button", { name: "New game", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "New game", exact: true }).scrollIntoViewIfNeeded();
    await expect(page).toHaveScreenshot("linked-new-game.png", {
        stylePath: scrollbarFreeScreenshot,
    });
    await page.getByRole("button", { name: "New game", exact: true }).click();
    await expect(page).toHaveURL("/");
    await playBoardMove(page, page.locator("cg-board").first(), "e2", "e4");
    await page.getByRole("button", { name: /^Save PGN/ }).click();
    const naming = page.getByRole("dialog", { name: "Save game", exact: true });
    await naming.getByRole("button", { name: "Save", exact: true }).click();
    await expect(naming).toHaveCount(0);
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
    await expect(page.getByRole("button", { name: /^Save PGN/ })).toHaveCount(0);
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

test("assertAccessible waits for a running colour transition before axe samples it", async ({
    page,
    assertAccessible,
}) => {
    await page.setContent(
        `<!doctype html><html lang="en"><head><title>Transition contrast</title></head><body><main><h1>Transition contrast</h1><button type="button" style="color:#ffffff;background-color:#f1eee9;transition:background-color 2000ms linear">Save</button></main></body></html>`,
    );
    // The 2 s transition starts on the white label's failing #f1eee9 background, so the check is red if assertAccessible stops settling transitions (f-20261115-22).
    await page.getByRole("button", { name: "Save", exact: true }).evaluate((el) => {
        const startColor = getComputedStyle(el).backgroundColor;
        el.style.backgroundColor = "#1f3a5f";
        return startColor;
    });
    await assertAccessible();
});
