import type { Token } from "../src/bindings/generated";
import {
    expect,
    filesWorkspaceCommands,
    filesWorkspaceFixture,
    pgnFileCommands,
    selectFilesTreeRow,
    test,
    waitForFontsSettled,
    scrollbarFreeScreenshot,
} from "./fixtures";

// A ChessBase export: `[#]` marks the diagram, the drawing commands sit in the same comment.
const tokens: Token[] = [
    { type: "Header", value: { tag: "Result", value: "*" } },
    { type: "San", value: "e4" },
    { type: "San", value: "e5" },
    { type: "San", value: "Nf3" },
    { type: "Comment", value: "[%csl Re5][%cal Gf3e5] [#] The knight attacks e5." },
    { type: "San", value: "Nc6" },
    { type: "San", value: "Bb5" },
    { type: "Outcome", value: "*" },
];

for (const tableView of [false, true]) {
    test(`notation-diagram: a marked move shows a read-only board with its shapes in ${tableView ? "table" : "inline"} view`, async ({
        page,
        mockScenario,
    }) => {
        await mockScenario({
            commands: filesWorkspaceCommands([[filesWorkspaceFixture.pgnFile]], {
                ...pgnFileCommands,
                lex_pgn: { pgnTokens: { [filesWorkspaceFixture.pgnGame]: tokens } },
            }),
        });
        await page.addInitScript((tableView) => {
            localStorage.setItem("mantine-color-scheme", "light");
            localStorage.setItem("letters", JSON.stringify("letters"));
            localStorage.setItem("table-view", JSON.stringify(tableView));
        }, tableView);
        await page.goto("/library");
        await page.getByRole("button", { name: "Choose folder", exact: true }).click();
        await selectFilesTreeRow(page, filesWorkspaceFixture.pgnFile.name);
        await page.getByRole("button", { name: "Open game", exact: true }).click();
        await expect(page).toHaveURL("/");

        const notation = page.locator("#bottomRight");
        const diagram = notation.locator("[data-notation-diagram]");
        await expect(diagram).toHaveCount(1);
        const board = diagram.locator("[data-mini-board]");
        await expect(board.locator("cg-board")).toBeVisible();
        expect((await board.boundingBox())!.width).toBe(200);
        // The marker itself is never shown as text.
        await expect(notation).not.toContainText("[#]");
        await expect(diagram).toContainText("The knight attacks e5.");
        // One circle and one arrow, drawn on the small board.
        await expect(board.locator("svg.cg-shapes g[cgHash]")).toHaveCount(2);
        await expect(board.locator("svg.cg-shapes line")).toHaveCount(1);
        await expect(board.locator("coords")).toHaveCount(0);

        // Below its move, above the next one.
        const knight = notation.getByRole("button", { name: "Nf3", exact: true });
        const reply = notation.getByRole("button", { name: "Nc6", exact: true });
        const diagramBox = (await diagram.boundingBox())!;
        const knightBox = (await knight.boundingBox())!;
        const replyBox = (await reply.boundingBox())!;
        expect(knightBox.y + knightBox.height).toBeLessThanOrEqual(diagramBox.y + 1);
        expect(diagramBox.y + diagramBox.height).toBeLessThanOrEqual(replyBox.y + 1);

        // A real click on the board jumps the main board to that position.
        await page.getByRole("button", { name: "Go to start", exact: true }).click();
        await expect(notation.locator('[data-notation-current="true"]')).toHaveCount(0);
        await board.click();
        await expect(notation.locator('[data-notation-current="true"]')).toContainText("f3");

        // The header View menu hides the diagram and hands the comment back to the move flow.
        await page.getByRole("button", { name: "View options", exact: true }).click();
        const showDiagrams = page.getByRole("menuitem", {
            name: "Show diagrams",
            exact: true,
        });
        await showDiagrams.click();
        await expect(diagram).toHaveCount(0);
        await expect(notation).toContainText("The knight attacks e5.");
        await showDiagrams.click();
        await expect(diagram).toHaveCount(1);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("menu")).toHaveCount(0);

        await page.mouse.move(0, 0);
        await waitForFontsSettled(page);
        await expect(notation).toHaveScreenshot(
            `notation-diagram-${tableView ? "table" : "inline"}.png`,
            { stylePath: scrollbarFreeScreenshot },
        );
        await expect(page.getByText("Unexpected Tauri IPC command", { exact: false })).toHaveCount(
            0,
        );
    });
}
