import {
    activeWorkspaceTab,
    databaseCommands,
    expect,
    filesWorkspaceCommands,
    filesWorkspaceFixture,
    pgnFileCommands,
    selectFilesTreeRow,
    test,
} from "./fixtures";
import type { Page } from "@playwright/test";
import type { NormalizedGame, Token } from "../src/bindings/generated";

const citation =
    "0-1 Beerdsen,T (2520)-Bluebaum,M (2651) Elllobregat op 3rd Sant Boi de Llobregat 2022 (3)";
const second =
    "0-1 Srinath,R (2255)-Deac,B (2690) Titled Tuesday intern op 19th Dec Late Chess.com INT blitz 2023 (6)";
const game: NormalizedGame = {
    stamp: "a".repeat(64),
    id: 1,
    white: "Beerdsen, Thomas",
    black: "Bluebaum, Matthias",
    white_id: 11,
    black_id: 22,
    white_elo: 2520,
    black_elo: 2651,
    result: "0-1",
    date: "2022.12.01",
    round: "3",
    event: "Elllobregat op 3rd",
    event_id: 1,
    site: "Sant Boi de Llobregat",
    site_id: 1,
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    moves: "1. d4 d5 0-1",
};
const preparation: Token[] = [
    { type: "Header", value: { tag: "White", value: "Preparation" } },
    { type: "Header", value: { tag: "Black", value: "Citations" } },
    {
        type: "Comment",
        value: `Before ${citation.replace("Beerdsen,T", "**Beerdsen,T**")} ordinary prose. ${second}`,
    },
    { type: "San", value: "e4" },
    { type: "San", value: "c5" },
    { type: "Outcome", value: "*" },
];
function commands(matches: NormalizedGame[]) {
    return filesWorkspaceCommands([[filesWorkspaceFixture.pgnFile]], {
        ...pgnFileCommands,
        ...databaseCommands("reference-database", "citations.db3", {
            title: "Local reference games",
            description: "Citation fixtures",
            player_count: 2,
            game_count: matches.length,
            event_count: 1,
            storage_size: "4096",
            indexed: false,
        }),
        lex_pgn: {
            pgnTokens: {
                [filesWorkspaceFixture.pgnGame]: preparation,
                [game.moves]: [
                    { type: "San", value: "d4" },
                    { type: "San", value: "d5" },
                    { type: "Outcome", value: "0-1" },
                ],
            },
        },
        get_players: {
            result: {
                data: [
                    { id: 11, name: game.white, elo: 2520 },
                    { id: 22, name: game.black, elo: 2651 },
                ],
                count: 2,
            },
        },
        get_games: { result: { data: matches, count: matches.length } },
    });
}

async function openPreparationGame(page: Page) {
    await page.getByRole("button", { name: "Open game", exact: true }).click();
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("button", { name: "e4", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "c5", exact: true })).toBeVisible();
    expect((await activeWorkspaceTab(page))?.gameOrigin).toMatchObject({
        kind: "file",
        file: { handle: filesWorkspaceFixture.pgnFile.handle },
        gameNumber: 0,
    });
}

test("citations: formatted notation, keyboard choice and narrow missing guidance", async ({
    page,
    mockScenario,
    capture,
    assertNoHorizontalOverflow,
}) => {
    await mockScenario({ commands: commands([game, { ...game, id: 2 }]) });
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose collection", exact: true }).click();
    await selectFilesTreeRow(page, filesWorkspaceFixture.pgnFile.name);
    await openPreparationGame(page);
    const reference = page.getByRole("button", { name: citation, exact: true });
    await expect(reference).toBeVisible();
    await expect(reference.locator("strong")).toHaveText("Beerdsen,T");
    await capture("citations-notation");
    await expect(page).toHaveScreenshot("citations-notation.png", { fullPage: true });
    await reference.focus();
    await reference.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Find referenced game" });
    await expect(dialog.getByText("Beerdsen, Thomas – Bluebaum, Matthias")).toHaveCount(2);
    await page.setViewportSize({ width: 320, height: 720 });
    await expect(dialog.getByText("Local reference games")).toHaveCount(2);
    await assertNoHorizontalOverflow();
    await capture("citations-choice-320");
    await expect(page).toHaveScreenshot("citations-choice-320.png", { fullPage: true });
    const open = dialog.getByRole("button", { name: "Open game", exact: true }).last();
    await open.focus();
    await open.press("Enter");
    await expect
        .poll(async () => (await activeWorkspaceTab(page))?.gameOrigin)
        .toMatchObject({
            kind: "database",
            database: { id: { id: "reference-database" } },
            gameId: 2,
        });
    await expect(page.getByRole("button", { name: "d4", exact: true })).toBeVisible();
    expect((await activeWorkspaceTab(page))?.gameOrigin).toMatchObject({
        kind: "database",
        database: { id: { id: "reference-database" } },
        gameId: 2,
    });

    await page.setViewportSize({ width: 800, height: 720 });
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose collection", exact: true }).click();
    await selectFilesTreeRow(page, filesWorkspaceFixture.pgnFile.name);
    await openPreparationGame(page);
    await page.getByRole("button", { name: second, exact: true }).click();
    await expect(dialog.getByText(/No matching game was found/)).toBeVisible();
    await page.setViewportSize({ width: 320, height: 720 });
    await assertNoHorizontalOverflow();
    await capture("citations-missing-320");
    await expect(page).toHaveScreenshot("citations-missing-320.png", { fullPage: true });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
});

test("citations: only a complete unique occurrence opens automatically", async ({
    page,
    mockScenario,
}) => {
    await mockScenario({ commands: commands([game]) });
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose collection", exact: true }).click();
    await selectFilesTreeRow(page, filesWorkspaceFixture.pgnFile.name);
    await openPreparationGame(page);
    await page.getByRole("button", { name: citation, exact: true }).click();
    await expect
        .poll(async () => (await activeWorkspaceTab(page))?.gameOrigin)
        .toMatchObject({ kind: "database", gameId: 1 });
    expect((await activeWorkspaceTab(page))?.gameOrigin).toMatchObject({
        kind: "database",
        gameId: 1,
    });
    await expect(page.getByRole("button", { name: "d5", exact: true })).toBeVisible();
});
