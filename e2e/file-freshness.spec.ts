import {
    expect,
    filesWorkspaceCommands,
    filesWorkspaceFixture,
    pgnFileCommands,
    selectFilesTreeRow,
    test,
} from "./fixtures";
import type { Page } from "@playwright/test";
import type { MockScenario } from "./fixtures";

const { pgnFile } = filesWorkspaceFixture;

const openedGame = {
    pgn: filesWorkspaceFixture.pgnGame,
    stamp: "e".repeat(64),
    revision: "e2e-pgn-revision",
    present: true,
};

async function openFileTab(
    page: Page,
    mockScenario: (scenario: MockScenario) => Promise<void>,
    linked = false,
) {
    await mockScenario({
        commands: filesWorkspaceCommands([[pgnFile]], {
            ...pgnFileCommands,
            ...(linked
                ? {
                      read_game: {
                          result: {
                              ...openedGame,
                              linked: {
                                  collection: "22222222-2222-4222-8222-222222222222",
                                  generation: openedGame.revision,
                                  ordinal: 0,
                                  stamp: openedGame.stamp,
                              },
                          },
                      },
                  }
                : {}),
            // The external writer wins before autosave commits this edited game. Let the board
            // render the move before the native refusal installs the conflict panel.
            write_game: {
                delay: 500,
                error: {
                    tag: "backend-error",
                    category: "stale-game",
                    message: "The game changed on disk",
                },
            },
        }),
    });
    await page.goto("/library");
    await page.getByRole("button", { name: /choose folder/i }).click();
    await selectFilesTreeRow(page, pgnFile.name);
    await page.getByRole("button", { name: "Open game", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator("[data-file-freshness]")).toHaveAttribute(
        "data-file-freshness",
        /^verified:/,
    );
}

async function makeEditedMove(page: Page) {
    const board = page.getByRole("grid", { name: "Chessboard, White orientation" });
    await board.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("gridcell", { name: "f3, White Knight", exact: true })).toHaveCount(
        1,
    );
}

async function switchTheme(page: Page, scheme: "light" | "dark") {
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Appearance", exact: true }).click();
    await page.getByText(scheme === "dark" ? "Dark" : "Light", { exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", scheme);
    await page.getByRole("link", { name: "Board", exact: true }).click();
    await page.mouse.move(400, 650);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
}

test("file-freshness: a linked save refuses an obsolete generation and keeps the dirty tree recoverable", async ({
    page,
    mockScenario,
}) => {
    await openFileTab(page, mockScenario, true);
    await makeEditedMove(page);
    const gate = page.locator("[data-file-freshness]");
    await expect(gate).toHaveAttribute("data-file-freshness", /^conflict:/, { timeout: 8_000 });
    const calls = await page.evaluate(() =>
        window.__E2E_TAURI__.invocations().filter(({ command }) => command === "write_game"),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toMatchObject({
        expected: { kind: "linkedGame", stamp: openedGame.stamp, revision: openedGame.revision },
        pgn: expect.stringContaining("Nf3"),
    });
    await expect(
        gate.getByRole("button", { name: "Save my version as a new game…" }),
    ).toBeVisible();
    await expect(page.getByRole("grid")).toHaveCount(0);
});

test("file-freshness: shows the conflict panel for an edited game changed on disk", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
    assertAccessible,
    capture,
}) => {
    await openFileTab(page, mockScenario);
    await makeEditedMove(page);
    const writes = await page.evaluate(() =>
        window.__E2E_TAURI__.invocations().filter(({ command }) => command === "write_game"),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0].args).toMatchObject({
        file: pgnFile.handle,
        n: 0,
        pgn: expect.stringContaining("Nf3"),
        expected: { kind: "game", stamp: openedGame.stamp },
    });

    const changedGame = {
        ...openedGame,
        pgn: filesWorkspaceFixture.pgnGame.replace('[Result "*"]', '[Result "1-0"]'),
        stamp: "f".repeat(64),
        revision: "e2e-pgn-revision-changed",
    };
    await page.evaluate((readGame) => {
        window.__E2E_TAURI__.configure({
            commands: {
                read_game: { result: readGame },
                file_revision: { result: readGame.revision },
            },
        });
    }, changedGame);

    const gate = page.locator("[data-file-freshness]");
    await expect(gate).toHaveAttribute("data-file-freshness", /^conflict:/, { timeout: 8_000 });
    await expect(gate).toContainText("This game changed on disk while you were editing.");
    await expect(gate.getByRole("button", { name: "Reload from disk" })).toBeVisible();
    await expect(
        gate.getByRole("button", { name: "Save my version as a new game…" }),
    ).toBeVisible();
    await expect(page.getByRole("grid")).toHaveCount(0);
    await expect(
        page.getByText("Unexpected Tauri IPC command: write_game", { exact: true }),
    ).toHaveCount(0);
    await assertNoHorizontalOverflow();
    await assertAccessible();
    await capture("file-freshness-conflict");
    await expect(page).toHaveScreenshot("file-freshness-conflict.png", { fullPage: true });

    await switchTheme(page, "dark");
    await expect(gate).toHaveAttribute("data-file-freshness", /^conflict:/);
    await assertAccessible();
    await capture("file-freshness-conflict-dark");
});

test("file-freshness: shows the unavailable panel when the source file disappears", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
    assertAccessible,
    capture,
}) => {
    await openFileTab(page, mockScenario);

    await page.evaluate(() => {
        window.__E2E_TAURI__.configure({
            commands: {
                file_revision: {
                    error: {
                        tag: "backend-error",
                        category: "missing-resource",
                        message: "The source PGN is no longer available.",
                    },
                },
            },
        });
    });

    const gate = page.locator("[data-file-freshness]");
    await expect(gate).toHaveAttribute("data-file-freshness", /^unavailable:/, {
        timeout: 8_000,
    });
    await expect(gate).toContainText("This game or its file is no longer available.");
    await expect(
        gate.getByRole("button", { name: "Save my version as a new game…" }),
    ).toBeVisible();
    await expect(gate.getByRole("button", { name: "Close tab" })).toBeVisible();
    await expect(page.getByRole("grid")).toHaveCount(0);
    await assertNoHorizontalOverflow();
    await assertAccessible();
    await capture("file-freshness-unavailable");
    await expect(page).toHaveScreenshot("file-freshness-unavailable.png", { fullPage: true });

    await switchTheme(page, "dark");
    await expect(gate).toHaveAttribute("data-file-freshness", /^unavailable:/);
    await assertAccessible();
    await capture("file-freshness-unavailable-dark");
});
