import type { Token } from "../src/bindings/generated";
import {
    activeWorkspaceTab,
    databaseLayoutCommands,
    expect,
    filesWorkspaceCommands,
    filesWorkspaceFixture,
    gameOpeningFixture,
    gotoPreservingStorage,
    test,
    waitForFontsSettled,
} from "./fixtures";

const REVISION = "e2e-opponent-prep-rev-1";

const repertoireFile = {
    ...filesWorkspaceFixture.pgnFile,
    handle: { id: { id: "prep-repertoire-file" }, kind: "fileWorkspace" as const },
    name: "Black vs e4",
    metadata: { type: "repertoire" as const, tags: [] },
    gameCount: 1,
    readError: null,
};

const chapter0Pgn =
    '[Event "?"]\n[Site "?"]\n[Date "????.??.??"]\n[Round "?"]\n[White "Sicilian Najdorf"]\n[Black "Mainline"]\n[Orientation "black"]\n[Result "*"]\n\n1. e4 (1. c4 e5) (1. b3) c5 2. Nf3 (2. Be2 Nf6) d6 3. d4 cxd4 4. Nxd4 *';

const chapters = [{ pgn: chapter0Pgn, stamp: "a".repeat(64), revision: REVISION, present: true }];

const chapter0Tokens: Token[] = [
    { type: "Header", value: { tag: "White", value: "Sicilian Najdorf" } },
    { type: "Header", value: { tag: "Black", value: "Mainline" } },
    { type: "Header", value: { tag: "Orientation", value: "black" } },
    { type: "Header", value: { tag: "Result", value: "*" } },
    { type: "San", value: "e4" },
    { type: "ParenOpen" },
    { type: "San", value: "c4" },
    { type: "San", value: "e5" },
    { type: "ParenClose" },
    { type: "ParenOpen" },
    { type: "San", value: "b3" },
    { type: "ParenClose" },
    { type: "San", value: "c5" },
    { type: "San", value: "Nf3" },
    { type: "ParenOpen" },
    { type: "San", value: "Be2" },
    { type: "San", value: "Nf6" },
    { type: "ParenClose" },
    { type: "San", value: "d6" },
    { type: "San", value: "d4" },
    { type: "San", value: "cxd4" },
    { type: "San", value: "Nxd4" },
    { type: "Outcome", value: "*" },
];

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -";
const AFTER_E4_C5 = "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -";
const AFTER_NF3 = "rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -";
const AFTER_D6 = "rnbqkbnr/pp2pppp/3p4/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -";

function stat(move: string, white: number, draw: number, black: number, last_played: string) {
    return {
        move,
        white,
        draw,
        black,
        unknown: 0,
        last_played,
        year_counts: [],
    };
}

test("opponent-preparation: lists lines and gaps and opens a line at its position", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
}) => {
    await page.addInitScript(() => {
        localStorage.setItem("mantine-color-scheme", "light");
        localStorage.setItem("font-size", "100");
        localStorage.setItem("auto-save", "false");
    });
    await page.clock.setFixedTime(new Date("2026-11-08T12:00:00Z"));

    await mockScenario({
        commands: {
            ...databaseLayoutCommands,
            ...filesWorkspaceCommands([[repertoireFile]], {
                list_file_workspace: { result: { entries: [repertoireFile], unread: [] } },
                count_pgn_games: { result: 1 },
                read_games: { pgnGames: chapters },
                read_game: { pgnGames: chapters },
                file_revision: { result: REVISION },
                lex_pgn: {
                    pgnTokens: {
                        [chapter0Pgn]: chapter0Tokens,
                    },
                },
            }),
            get_progress: { result: null },
            search_positions_stats: {
                result: [
                    {
                        fen: START,
                        openings: [
                            stat("e4", 12, 4, 3, "2026.09.10"),
                            stat("d4", 4, 2, 1, "2026.06.05"),
                        ],
                    },
                    {
                        fen: AFTER_E4,
                        openings: [stat("c5", 8, 2, 2, "2026.09.10")],
                    },
                    {
                        fen: AFTER_E4_C5,
                        openings: [
                            stat("Nf3", 5, 1, 1, "2026.09.10"),
                            stat("Nc3", 3, 1, 1, "2026.08.15"),
                        ],
                    },
                    {
                        fen: AFTER_NF3,
                        openings: [stat("d6", 4, 1, 1, "2026.09.10")],
                    },
                    {
                        fen: AFTER_D6,
                        openings: [stat("Bb5+", 4, 1, 1, "2026.09.10")],
                    },
                ],
            },
        },
    });

    // Establish the library workspace through the normal Library flow.
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    await expect(page.getByText("Black vs e4")).toBeVisible();

    // Open the database player card and switch to the Preparation tab.
    await gotoPreservingStorage(page, `/databases/${gameOpeningFixture.databaseId}`);
    await page.getByRole("tab", { name: "Players", exact: true }).click();
    const players = page.getByRole("tabpanel", { name: "Players", exact: true });
    await players
        .locator('[data-database-pane="table"] tbody tr')
        .filter({ hasText: "First White" })
        .click();
    const preview = players.locator('[data-database-pane="preview"]');
    await preview.getByRole("tab", { name: "Preparation", exact: true }).click();

    const prep = preview.locator("[data-player-preparation]");
    await expect(prep.locator("[data-preparation-summary]")).toContainText("26 games");
    await expect(prep.locator("[data-preparation-lines]")).toContainText("Sicilian Najdorf");
    await expect(prep.locator("[data-preparation-lines]")).toContainText("6 of 26 games");
    await expect(prep.locator("[data-preparation-gaps]")).toContainText("Bb5+");
    await expect(prep.locator("[data-preparation-gaps]")).toContainText("Nc3");

    await assertNoHorizontalOverflow();
    await waitForFontsSettled(page);
    await page.mouse.move(0, 0);
    await expect(preview).toHaveScreenshot("opponent-preparation-tab.png");

    // Activating a line opens the repertoire chapter at the matched position (2...d6).
    await prep.locator("[data-preparation-line-row]").first().click();
    await expect(page).toHaveURL("/");
    expect((await activeWorkspaceTab(page))?.gameOrigin).toMatchObject({
        kind: "file",
        gameNumber: 0,
    });
    const notation = page.locator("#bottomRight");
    await expect(notation.getByRole("button", { name: "d6", exact: true })).toHaveAttribute(
        "aria-current",
        "true",
    );
    await expect(notation.locator("[data-notation-preparation-header]")).toContainText(
        "Preparing for First White",
    );
    await expect(notation.getByRole("button", { name: "c4", exact: true })).toHaveCount(0);
    await expect(notation.getByRole("button", { name: "b3", exact: true })).toHaveCount(0);
    await expect(notation.getByRole("button", { name: /Be2|♗e2/ })).toHaveCount(0);
    await expect(notation.locator('[data-notation-reveal-variations="2"]')).toContainText(
        "2 hidden lines",
    );
    await expect(notation.locator('[data-notation-reveal-variations="1"]')).toContainText(
        "1 hidden line",
    );
    await waitForFontsSettled(page);
    await page.mouse.move(0, 0);
    await expect(notation).toHaveScreenshot("opponent-preparation-opened-line.png");

    // Revealing by toggle opens only that parent's hidden side lines.
    await notation.locator('[data-notation-reveal-variations="2"]').click();
    await expect(notation.getByRole("button", { name: "c4", exact: true })).toBeVisible();
    await expect(notation.getByRole("button", { name: "b3", exact: true })).toBeVisible();
    await expect(notation.getByRole("button", { name: /Be2|♗e2/ })).toHaveCount(0);

    // Switching to "All lines" shows the remaining side lines; switching back restores the filter.
    await notation.getByText("All lines", { exact: true }).click();
    await expect(notation.getByRole("button", { name: /Be2|♗e2/ })).toBeVisible();
    await notation.getByText("Opponent's lines", { exact: true }).click();
    await expect(notation.getByRole("button", { name: /Be2|♗e2/ })).toHaveCount(0);

    // Table view also follows the filter.
    await page.getByRole("button", { name: "Table view", exact: true }).click();
    await expect(notation.getByRole("button", { name: /Be2|♗e2/ })).toHaveCount(0);
    await expect(notation.locator('[data-notation-reveal-variations="1"]')).toBeVisible();
    await notation.getByText("All lines", { exact: true }).click();
    await expect(notation.getByRole("button", { name: /Be2|♗e2/ })).toBeVisible();

    await expect(page.getByText(/Unexpected Tauri IPC command:/)).toHaveCount(0);
});
