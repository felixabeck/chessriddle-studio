import { INITIAL_FEN } from "chessops/fen";
import { deserializeStorageValue } from "../src/state/store/debouncedStorage";
import {
    activeWorkspaceTab,
    expect,
    filesWorkspaceCommands,
    gameOpeningCommands,
    gameOpeningFixture,
    playBoardMove,
    selectFilesTreeRow,
    test,
    waitForFontsSettled,
} from "./fixtures";
import type { Page } from "@playwright/test";

const liveState = {
    session: 1,
    revision: 0,
    status: "playing",
    initialFen: INITIAL_FEN,
    currentFen: INITIAL_FEN,
    moves: [] as {
        uci: string;
        san: string;
        clock: null;
        whiteTime: null;
        blackTime: null;
        fenAfter: string;
    }[],
    ply: 0,
    turn: "white",
    whitePlayer: "Human",
    blackPlayer: "E2E engine",
    whiteTime: null,
    blackTime: null,
};

const acceptedMove = {
    uci: "e2e4",
    san: "e4",
    clock: null,
    whiteTime: null,
    blackTime: null,
    fenAfter: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
};

async function ipcCount(page: Page, command: string) {
    return page.evaluate(
        (value) =>
            window.__E2E_TAURI__.invocations().filter((entry) => entry.command === value).length,
        command,
    );
}

async function waitForCloseRequestedListener(page: Page) {
    await expect
        .poll(async () =>
            page.evaluate(() =>
                window.__E2E_TAURI__
                    .invocations()
                    .some(
                        (entry) =>
                            entry.command === "plugin:event|listen" &&
                            (entry.args as { event?: string } | undefined)?.event ===
                                "tauri://close-requested",
                    ),
            ),
        )
        .toBe(true);
}

async function activeTabTreeDirty(page: Page) {
    const tab = await activeWorkspaceTab(page);
    if (!tab) return false;
    const key = tab.treeKey ?? tab.value;
    const stored = await page.evaluate((id) => sessionStorage.getItem(id), key);
    const tree = stored && deserializeStorageValue<{ state?: { dirty?: boolean } }>(stored);
    return tree?.state?.dirty === true;
}

const quitDialog = (page: Page) => page.getByRole("dialog").filter({ hasText: "Unsaved changes" });

async function expectQuitDialog(page: Page, snapshot: string) {
    const dialog = quitDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS("opacity", "1");
    await expect(
        dialog.getByRole("button", { name: "Quit without saving", exact: true }),
    ).toBeVisible();
    expect(await ipcCount(page, "plugin:window|destroy")).toBe(0);
    await waitForFontsSettled(page);
    await expect(page).toHaveScreenshot(snapshot, { fullPage: true });
}

async function clickTitleBarClose(page: Page) {
    await page.getByRole("button", { name: "Close window", exact: true }).click();
}

async function clickCompactFileExit(page: Page) {
    const menu = page.getByRole("button", { name: "Application menu", exact: true });
    await menu.click();
    const exit = page.getByRole("menuitem", { name: "Exit", exact: true });
    await expect(exit).toBeVisible();
    await exit.click();
    await expect(page.getByRole("menu")).toHaveCount(0);
}

async function openOriginNoneAnalysis(page: Page) {
    await page.goto("/");
    await waitForCloseRequestedListener(page);
    await page.getByRole("button", { name: /^Analysis Board$/ }).click();
    const tab = (await activeWorkspaceTab(page))!;
    expect(tab.type).toBe("analysis");
    expect(tab.gameOrigin).toEqual({ kind: "none" });
    const board = page.locator("cg-board").first();
    await playBoardMove(page, board, "e2", "e4");
    await expect.poll(() => activeTabTreeDirty(page)).toBe(true);
}

async function openDirtyOriginNonePlay(page: Page) {
    await page.addInitScript(() =>
        localStorage.setItem(
            "engines",
            JSON.stringify([
                {
                    type: "local",
                    id: "game-engine",
                    name: "E2E engine",
                    version: "1",
                    filename: "engine",
                    handle: { id: { id: "game-engine-handle" }, kind: "engine" },
                    settings: [],
                    go: { t: "Depth", c: 1 },
                },
            ]),
        ),
    );
    await page.goto("/");
    await waitForCloseRequestedListener(page);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    const tab = (await activeWorkspaceTab(page))!;
    expect(tab.type).toBe("play");
    expect(tab.gameOrigin).toEqual({ kind: "none" });
    await page.getByText("Engine", { exact: true }).last().click();
    await page.getByRole("button", { name: "Start game", exact: true }).click();
    await expect(page.getByRole("button", { name: "Resign", exact: true })).toBeVisible();
    const board = page.locator("cg-board").first();
    await playBoardMove(page, board, "e2", "e4");
    await expect.poll(() => activeTabTreeDirty(page)).toBe(true);
    return tab;
}

async function expectImmediateDestroy(page: Page) {
    await expect
        .poll(async () => ({
            destroy: await ipcCount(page, "plugin:window|destroy"),
            dialogs: await quitDialog(page).count(),
        }))
        .toEqual({ destroy: 1, dialogs: 0 });
}

/**
 * Holds every session-store write past the quit gate's drain, so a dirty game has no durable
 * copy and the gate must still ask before quitting.
 */
const recoveryCopyPending = {
    write_workspace_session_leaf: { result: null, delay: 600_000 },
};

const gestures = [
    { name: "title-bar close", run: clickTitleBarClose, snapshot: "dirty-analysis-title-bar.png" },
    {
        name: "compact File → Exit",
        run: clickCompactFileExit,
        snapshot: "dirty-analysis-file-exit.png",
    },
] as const;

for (const gesture of gestures) {
    test(`quit-gate: dirty origin-none analysis ${gesture.name} without a recovery copy shows the dialog, then Quit without saving destroys once`, async ({
        page,
        mockScenario,
    }) => {
        await mockScenario({ commands: recoveryCopyPending });
        await openOriginNoneAnalysis(page);
        await gesture.run(page);
        await expectQuitDialog(page, gesture.snapshot);
        await quitDialog(page)
            .getByRole("button", { name: "Quit without saving", exact: true })
            .click();
        await expect.poll(() => ipcCount(page, "plugin:window|destroy")).toBe(1);
    });

    test(`quit-gate: dirty origin-none analysis ${gesture.name} with a stored recovery copy destroys without a dialog`, async ({
        page,
    }) => {
        await openOriginNoneAnalysis(page);
        const tab = (await activeWorkspaceTab(page))!;
        const treeKey = tab.treeKey ?? tab.value;
        await expect
            .poll(() =>
                page.evaluate((key) => {
                    const writes = window.__E2E_TAURI__
                        .invocations()
                        .filter((entry) => entry.command === "write_workspace_session_leaf")
                        .map((entry) => (entry.args as { key?: string } | undefined)?.key);
                    return writes.includes(key) && writes.includes("workspace");
                }, treeKey),
            )
            .toBe(true);
        await gesture.run(page);
        await expectImmediateDestroy(page);
    });

    test(`quit-gate: no dirty tab ${gesture.name} destroys immediately`, async ({ page }) => {
        await page.goto("/");
        await waitForCloseRequestedListener(page);
        const tab = (await activeWorkspaceTab(page))!;
        expect(tab.type).toBe("new");
        expect(await activeTabTreeDirty(page)).toBe(false);
        await gesture.run(page);
        await expectImmediateDestroy(page);
    });

    test(`quit-gate: dirty origin-none play ${gesture.name} destroys without a dialog`, async ({
        page,
        mockScenario,
    }) => {
        await mockScenario({
            commands: {
                start_game: { gameState: liveState },
                get_game_state: { gameState: liveState },
                make_game_move: {
                    gameState: {
                        ...liveState,
                        revision: 1,
                        ply: 1,
                        turn: "black",
                        currentFen: acceptedMove.fenAfter,
                        moves: [acceptedMove],
                    },
                },
            },
        });
        const tab = await openDirtyOriginNonePlay(page);
        expect(tab.type).toBe("play");
        expect(await activeTabTreeDirty(page)).toBe(true);
        await gesture.run(page);
        await expectImmediateDestroy(page);
    });
}

async function openDirtyDatabaseDraft(page: Page) {
    await page.addInitScript(() => localStorage.setItem("auto-save", "false"));
    await page.goto("/library");
    await waitForCloseRequestedListener(page);
    await selectFilesTreeRow(page, gameOpeningFixture.databaseTitle);
    await page.getByRole("button", { name: "New game", exact: true }).click();
    await expect(page).toHaveURL("/");
    const tab = (await activeWorkspaceTab(page))!;
    expect(tab.gameOrigin.kind).toBe("databaseDraft");
    expect(tab.name).toBe("New game");
    await playBoardMove(page, page.locator("cg-board").first(), "e2", "e4");
    await expect.poll(() => activeTabTreeDirty(page)).toBe(true);
}

const saveAndQuit = (page: Page) =>
    quitDialog(page).getByRole("button", { name: "Save and quit", exact: true });

test("quit-gate: Save and quit stores a new database game, then destroys once", async ({
    page,
    mockScenario,
}) => {
    await mockScenario({
        commands: filesWorkspaceCommands([[]], {
            ...gameOpeningCommands,
            ...recoveryCopyPending,
            insert_db_game: { result: { id: 501, stamp: "a".repeat(64) } },
        }),
    });
    await openDirtyDatabaseDraft(page);
    await clickTitleBarClose(page);
    await expectQuitDialog(page, "dirty-database-draft.png");
    await expect(quitDialog(page).getByRole("listitem")).toHaveText(["New game"]);
    await saveAndQuit(page).click();
    await expect.poll(() => ipcCount(page, "plugin:window|destroy")).toBe(1);
    expect(await ipcCount(page, "insert_db_game")).toBe(1);
});

test("quit-gate: a failed Save and quit keeps the window, names the tab, and can be cancelled", async ({
    page,
    mockScenario,
}) => {
    await mockScenario({
        commands: filesWorkspaceCommands([[]], {
            ...gameOpeningCommands,
            ...recoveryCopyPending,
            insert_db_game: { error: "The database is locked." },
        }),
    });
    await openDirtyDatabaseDraft(page);
    await clickTitleBarClose(page);
    await saveAndQuit(page).click();
    await expect(quitDialog(page)).toContainText("“New game” could not be saved.");
    await expect(quitDialog(page).getByRole("listitem")).toHaveText(["New game"]);
    expect(await ipcCount(page, "plugin:window|destroy")).toBe(0);
    await waitForFontsSettled(page);
    await expect(page).toHaveScreenshot("failed-save-and-quit.png", { fullPage: true });
    await quitDialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(quitDialog(page)).toHaveCount(0);
    expect(await activeTabTreeDirty(page)).toBe(true);
});
