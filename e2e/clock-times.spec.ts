import type { NormalizedGame, Token } from "../src/bindings/generated";
import {
    expect,
    filesWorkspaceCommands,
    filesWorkspaceFixture,
    gameOpeningCommands,
    gameOpeningFixture,
    pgnFileCommands,
    scrollbarFreeScreenshot,
    selectFilesTreeRow,
    test,
    waitForFontsSettled,
} from "./fixtures";

const clockGamePgn =
    '[Event "E2E Clock"]\n[White "Weiss"]\n[Black "Schwarz"]\n[Result "*"]\n\n1. e4 e5 2. Nf3 *';

const clockGameTokens: Token[] = [
    { type: "Header", value: { tag: "Event", value: "E2E Clock" } },
    { type: "Header", value: { tag: "White", value: "Weiss" } },
    { type: "Header", value: { tag: "Black", value: "Schwarz" } },
    { type: "Header", value: { tag: "Result", value: "*" } },
    { type: "San", value: "e4" },
    { type: "San", value: "e5" },
    { type: "San", value: "Nf3" },
    { type: "Outcome", value: "*" },
];

test("Annotate clock entry shows board clocks without a tag and Info preset updates plain words and tooltips", async ({
    page,
    mockScenario,
}) => {
    await mockScenario({
        commands: filesWorkspaceCommands([[filesWorkspaceFixture.pgnFile]], {
            ...pgnFileCommands,
            read_games: {
                result: [
                    {
                        pgn: clockGamePgn,
                        stamp: "e".repeat(64),
                        revision: "e2e-pgn-revision",
                        present: true,
                    },
                ],
            },
            read_game: {
                result: {
                    pgn: clockGamePgn,
                    stamp: "e".repeat(64),
                    revision: "e2e-pgn-revision",
                    present: true,
                },
            },
            write_game: { result: { stamp: "e".repeat(64), revision: "e2e-pgn-revision" } },
            lex_pgn: { pgnTokens: { [clockGamePgn]: clockGameTokens } },
        }),
    });
    await page.addInitScript(() => {
        localStorage.setItem("mantine-color-scheme", "light");
    });

    await page.goto("/library");
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    await selectFilesTreeRow(page, filesWorkspaceFixture.pgnFile.name);
    await page.getByRole("button", { name: "Open game", exact: true }).click();
    await expect(page).toHaveURL("/");

    const notation = page.locator("#bottomRight");
    await page.getByRole("tab", { name: "Annotate", exact: true }).click();
    await notation.getByRole("button", { name: "e4", exact: true }).click();

    const clockField = page.getByLabel("Clock", { exact: true });
    await clockField.click();
    await page.keyboard.type("86");
    await page.keyboard.press("Tab");

    // A node clock shows the board clock even without a TimeControl header.
    await expect(page.locator("#left").getByText("1:26:00")).toBeVisible();

    await page.keyboard.type("85");
    await page.keyboard.press("Tab");
    await expect(page.locator("#left").getByText("1:25:00")).toBeVisible();

    // Entering White's second move clock shows time spent on the move.
    await page.keyboard.type("84");
    await page.keyboard.press("Enter");
    await expect(page.locator("#left").getByText("1:24:00")).toBeVisible();
    await expect(page.locator("#left").getByText("02:00")).toBeVisible();

    await page.mouse.move(0, 0);
    await waitForFontsSettled(page);
    await expect(page).toHaveScreenshot("clock-times-annotate.png", {
        stylePath: scrollbarFreeScreenshot,
    });

    // Pick a time control preset in Info and verify plain words + clock tooltips.
    await page.getByRole("tab", { name: "Info", exact: true }).click();
    const timeControlSelect = page.getByRole("textbox", { name: "Time control", exact: true });
    await timeControlSelect.click();
    await page.getByRole("option", { name: "90 min + 30 s per move", exact: true }).click();

    await expect(timeControlSelect).toHaveValue("90 min + 30 s per move");
    await expect(page.locator('#left [title="90 min + 30 s per move"]')).toHaveCount(2);

    await page.keyboard.press("Escape");
    await page.mouse.move(0, 0);
    await waitForFontsSettled(page);
    await expect(page.locator("#topRight")).toHaveScreenshot("clock-times-info.png", {
        stylePath: scrollbarFreeScreenshot,
    });

    // Open Custom, fill 90 / 30 / after move 40 / add 30, assert plain words, and capture layout.
    await timeControlSelect.click();
    await page.getByRole("option", { name: "Custom", exact: true }).click();
    const topRight = page.locator("#topRight");
    await topRight.getByLabel("Minutes", { exact: true }).fill("90");
    await topRight.getByLabel("Increment (s)", { exact: true }).fill("30");
    await topRight.getByLabel("After move", { exact: true }).fill("40");
    await topRight.getByLabel("Add (min)", { exact: true }).fill("30");

    await expect(
        topRight.getByText("40 moves in 90 min, then 30 min, + 30 s per move", { exact: true }),
    ).toBeVisible();

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
    await page.mouse.move(0, 0);
    await waitForFontsSettled(page);
    await expect(topRight).toHaveScreenshot("clock-times-info-custom.png", {
        stylePath: scrollbarFreeScreenshot,
    });
    await expect(page.getByText("Unexpected Tauri IPC command", { exact: false })).toHaveCount(0);
});

test("read-only database preview fits the resolved time control at 20rem", async ({
    page,
    mockScenario,
}) => {
    const timedGame: NormalizedGame = {
        ...gameOpeningFixture.games[0],
        time_control: "40/5400+30:1800+30",
    };
    const games = [timedGame, gameOpeningFixture.games[1]];
    await mockScenario({
        commands: {
            ...gameOpeningCommands,
            get_games: { result: { data: games, count: 2 } },
            get_db_game: { databaseGames: games },
        },
    });
    await page.addInitScript(() => {
        localStorage.setItem("mantine-color-scheme", "light");
        localStorage.setItem("database-table-percentage", "80");
    });

    await page.goto(`/databases/${gameOpeningFixture.databaseId}`);
    await page.locator("tbody tr").filter({ hasText: "First White" }).click();

    const previewPane = page.locator('[data-database-pane="preview"]');
    const previewText = previewPane.getByText(
        "Time control: 40 moves in 90 min, then 30 min, + 30 s per move",
    );
    await expect(previewText).toBeVisible();
    await expect(
        previewPane.getByRole("textbox", { name: "Time control", exact: true }),
    ).toHaveCount(0);

    await waitForFontsSettled(page);
    const overflow = await previewPane.locator("[data-game-info-fields]").evaluate((grid) => {
        const card = grid.closest(".mantine-Paper-root")!.getBoundingClientRect();
        return {
            cardWidth: card.width,
            clipped: [...grid.querySelectorAll("input, button, span, a, p")]
                .filter((el) => el.getBoundingClientRect().width > 0)
                .some((el) => {
                    const box = el.getBoundingClientRect();
                    return box.left < card.left - 1 || box.right > card.right + 1;
                }),
        };
    });
    // 20rem card width (320 px) plus the card's padding and border.
    const MAX_20REM_CARD_WIDTH_PX = 340;
    expect(overflow.clipped).toBe(false);
    expect(overflow.cardWidth).toBeLessThanOrEqual(MAX_20REM_CARD_WIDTH_PX);

    await page.mouse.move(0, 0);
    await expect(previewPane.locator(".mantine-Paper-root").first()).toHaveScreenshot(
        "clock-times-database-preview-20rem.png",
        { stylePath: scrollbarFreeScreenshot },
    );
    await expect(page.getByText("Unexpected Tauri IPC command", { exact: false })).toHaveCount(0);
});
