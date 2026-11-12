import type { Token } from "../src/bindings/generated";
import {
    expect,
    filesWorkspaceCommands,
    filesWorkspaceFixture,
    pgnFileCommands,
    playBoardMove,
    selectFilesTreeRow,
    test,
    waitForFontsSettled,
} from "./fixtures";

const tokens: Token[] = [
    { type: "Header", value: { tag: "Result", value: "0-1" } },
    { type: "Header", value: { tag: "Termination", value: "Abandoned" } },
    { type: "San", value: "e4" },
    { type: "San", value: "e5" },
    { type: "Outcome", value: "0-1" },
];

for (const colorScheme of ["light", "dark"] as const) {
    for (const tableView of [true, false]) {
        test(`game-end: appended analysis follows the inline result and has reduced opacity in ${tableView ? "table" : "inline"} view, ${colorScheme}`, async ({
            page,
            mockScenario,
        }) => {
            await mockScenario({
                commands: filesWorkspaceCommands([[filesWorkspaceFixture.pgnFile]], {
                    ...pgnFileCommands,
                    write_game: { result: { stamp: "e".repeat(64), revision: "e2e-pgn-revision" } },
                    lex_pgn: { pgnTokens: { [filesWorkspaceFixture.pgnGame]: tokens } },
                }),
            });
            await page.emulateMedia({ colorScheme });
            await page.addInitScript(
                ({ colorScheme, tableView }) => {
                    localStorage.setItem("mantine-color-scheme", colorScheme);
                    localStorage.setItem("letters", JSON.stringify("letters"));
                    localStorage.setItem("table-view", JSON.stringify(tableView));
                },
                { colorScheme, tableView },
            );
            await page.goto("/library");
            await page.getByRole("button", { name: "Choose folder", exact: true }).click();
            await selectFilesTreeRow(page, filesWorkspaceFixture.pgnFile.name);
            await page.getByRole("button", { name: "Open game", exact: true }).click();
            await expect(page).toHaveURL("/");
            const notation = page.locator("#bottomRight");
            const end = notation.getByRole("button", { name: "e5", exact: true });
            await end.click();
            await playBoardMove(page, page.locator("cg-board").first(), "g1", "f3");
            const analysis = notation.getByRole("button", { name: "Nf3", exact: true });
            await expect(analysis).toBeVisible();
            await page.getByRole("button", { name: "Go to start", exact: true }).click();
            await page.mouse.move(0, 0);
            await waitForFontsSettled(page);
            await expect(notation.locator('[data-notation-current="true"]')).toHaveCount(0);
            expect(await end.evaluate((element) => element.matches(":hover"))).toBe(false);
            expect(await analysis.evaluate((element) => element.matches(":hover"))).toBe(false);
            expect(await analysis.evaluate((element) => !!element.closest("td"))).toBe(tableView);
            const boundary = notation.locator("[data-notation-game-end]");
            await expect(boundary).toContainText("0-1 · Black wins · Abandoned");
            await expect(boundary).toContainText("Analysis after the game");
            await expect(analysis).toHaveAttribute("data-notation-analysis", "true");
            await expect(end).not.toHaveAttribute("data-notation-analysis");
            const endBox = (await end.boundingBox())!;
            const boundaryBox = (await boundary.boundingBox())!;
            const analysisBox = (await analysis.boundingBox())!;
            expect(endBox.y + endBox.height).toBeLessThanOrEqual(boundaryBox.y + 1);
            expect(boundaryBox.y + boundaryBox.height).toBeLessThanOrEqual(analysisBox.y + 1);
            const playedOpacity = await end.evaluate(
                (element) => getComputedStyle(element).opacity,
            );
            const analysisOpacity = await analysis.evaluate(
                (element) => getComputedStyle(element).opacity,
            );
            expect(analysisOpacity).toBe("0.6");
            expect(playedOpacity).toBe("1");
            await expect(
                page.getByText("Unexpected Tauri IPC command", { exact: false }),
            ).toHaveCount(0);
        });
    }
}
