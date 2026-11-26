import type { Page } from "@playwright/test";
import type { Token } from "../src/bindings/generated";
import {
    activeWorkspaceTab,
    expect,
    filesWorkspaceCommands,
    filesWorkspaceFixture,
    playBoardMove,
    scrollbarFreeScreenshot,
    seedBoardLayouts,
    selectFilesTreeRow,
    test,
    waitForFontsSettled,
} from "./fixtures";

const REVISION = "e2e-file-wide-transpositions-rev-1";

const repertoireFile = {
    ...filesWorkspaceFixture.pgnFile,
    handle: { id: { id: "transposition-repertoire" }, kind: "fileWorkspace" as const },
    name: "Openings",
    metadata: { type: "repertoire" as const, tags: [] },
    gameCount: 2,
};

const chapter0Pgn =
    '[Event "?"]\n[Site "?"]\n[Date "????.??.??"]\n[Round "?"]\n[White "Italian Base"]\n[Black "?"]\n[Result "*"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 *';
const chapter1Pgn =
    '[Event "?"]\n[Site "?"]\n[Date "????.??.??"]\n[Round "?"]\n[White "King Knight Detour"]\n[Black "?"]\n[Result "*"]\n\n1. Nf3 Nc6 2. e4 e5 *';

const chapters = [
    { pgn: chapter0Pgn, stamp: "a".repeat(64), revision: REVISION, present: true },
    { pgn: chapter1Pgn, stamp: "b".repeat(64), revision: REVISION, present: true },
];

const chapter0Tokens: Token[] = [
    { type: "Header", value: { tag: "White", value: "Italian Base" } },
    { type: "Header", value: { tag: "Result", value: "*" } },
    { type: "San", value: "e4" },
    { type: "San", value: "e5" },
    { type: "San", value: "Nf3" },
    { type: "San", value: "Nc6" },
    { type: "San", value: "Bc4" },
    { type: "San", value: "Bc5" },
    { type: "Outcome", value: "*" },
];

const chapter1Tokens: Token[] = [
    { type: "Header", value: { tag: "White", value: "King Knight Detour" } },
    { type: "Header", value: { tag: "Result", value: "*" } },
    { type: "San", value: "Nf3" },
    { type: "San", value: "Nc6" },
    { type: "San", value: "e4" },
    { type: "San", value: "e5" },
    { type: "Outcome", value: "*" },
];

async function openSecondChapterOnAnnotate(page: Page) {
    await seedBoardLayouts(page);
    await page.addInitScript(() => {
        localStorage.setItem("mantine-color-scheme", "light");
        localStorage.setItem("letters", JSON.stringify("letters"));
        localStorage.setItem("auto-save", "false");
    });
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    await selectFilesTreeRow(page, repertoireFile.name);
    const secondChapter = page.locator('[data-line-index="1"] [role="option"]');
    await secondChapter.dblclick();
    await expect(page).toHaveURL("/");
    expect((await activeWorkspaceTab(page))?.gameOrigin).toMatchObject({ gameNumber: 1 });
    await expect(page.locator("[data-file-freshness]")).toHaveAttribute(
        "data-file-freshness",
        /^verified:/,
    );

    // Switch away from Info so the Info panel's chapter list is unmounted.
    const annotateTab = page.getByRole("tab", { name: "Annotate", exact: true });
    await annotateTab.click();
    await expect(annotateTab).toHaveAttribute("aria-selected", "true");
}

function buildCommands() {
    return filesWorkspaceCommands([[repertoireFile]], {
        count_pgn_games: { result: 2 },
        read_games: { pgnGames: chapters },
        read_game: { pgnGames: chapters },
        file_revision: { result: REVISION },
        lex_pgn: {
            pgnTokens: {
                [chapter0Pgn]: chapter0Tokens,
                [chapter1Pgn]: chapter1Tokens,
            },
        },
    });
}

test("file-wide-transpositions: marker names target chapter and switches with Info unmounted", async ({
    page,
    mockScenario,
}) => {
    await mockScenario({ commands: buildCommands() });
    await openSecondChapterOnAnnotate(page);

    const notation = page.locator("#bottomRight");
    const marker = notation.getByRole("button", {
        name: "Transposition in Italian Base",
        exact: true,
    });
    await expect(marker).toHaveCount(1);
    await expect(notation).not.toContainText("Transposition");

    // Verify the marker sits right beside 2...e5 (the transposing move).
    const e5Move = notation.getByRole("button", { name: "e5", exact: true });
    const e5Box = (await e5Move.boundingBox())!;
    const markerBox = (await marker.boundingBox())!;
    expect(markerBox.x).toBeGreaterThanOrEqual(e5Box.x + e5Box.width - 1);
    expect(Math.abs(markerBox.y - e5Box.y)).toBeLessThanOrEqual(8);

    await page.mouse.move(0, 0);
    await waitForFontsSettled(page);
    await expect(notation).toHaveScreenshot("file-wide-transpositions-notation.png", {
        stylePath: scrollbarFreeScreenshot,
    });

    await marker.click();
    await expect
        .poll(async () => {
            const tab = await activeWorkspaceTab(page);
            return tab?.gameOrigin.kind === "file" ? tab.gameOrigin.gameNumber : -1;
        })
        .toBe(0);
    await expect(notation.locator('[data-notation-current="true"]')).toContainText("Nc6");
    await expect(page.getByText("Unexpected Tauri IPC command", { exact: false })).toHaveCount(0);
});

test("file-wide-transpositions: clicking the marker on a dirty tree shows the unsaved-changes prompt", async ({
    page,
    mockScenario,
}) => {
    await mockScenario({ commands: buildCommands() });
    await openSecondChapterOnAnnotate(page);

    const notation = page.locator("#bottomRight");
    const marker = notation.getByRole("button", {
        name: "Transposition in Italian Base",
        exact: true,
    });
    await expect(marker).toHaveCount(1);

    // Play a non-transposing continuation after 2...e5 so the open tree becomes dirty.
    await notation.getByRole("button", { name: "e5", exact: true }).click();
    await playBoardMove(page, page.locator("cg-board").first(), "a2", "a3");
    await expect(notation.getByRole("button", { name: "a3", exact: true })).toHaveCount(1);

    await marker.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Unsaved changes");
    await waitForFontsSettled(page);
    await expect(dialog).toHaveScreenshot("unsaved-changes-dialog.png");

    // The close button aborts the switch: no save, no discard, the dirty tree stays.
    await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(notation.getByRole("button", { name: "a3", exact: true })).toHaveCount(1);
    expect((await activeWorkspaceTab(page))?.gameOrigin).toMatchObject({ gameNumber: 1 });
});
