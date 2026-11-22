import type { Token } from "../src/bindings/generated";
import {
    expect,
    filesWorkspaceCommands,
    filesWorkspaceFixture,
    pgnFileCommands,
    scrollbarFreeScreenshot,
    selectFilesTreeRow,
    test,
    waitForFontsSettled,
} from "./fixtures";

// 1. e4 e5 (1... c5) 2. Nf3: c5 opens a variation, so it can carry a comment in front of it.
const tokens: Token[] = [
    { type: "Header", value: { tag: "Result", value: "*" } },
    { type: "San", value: "e4" },
    { type: "San", value: "e5" },
    { type: "ParenOpen" },
    { type: "San", value: "c5" },
    { type: "ParenClose" },
    { type: "San", value: "Nf3" },
    { type: "Outcome", value: "*" },
];

test("annotation-comment-before: the first move of a variation takes a comment in front of it", async ({
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
    await page.addInitScript(() => {
        localStorage.setItem("mantine-color-scheme", "light");
        localStorage.setItem("letters", JSON.stringify("letters"));
    });
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    await selectFilesTreeRow(page, filesWorkspaceFixture.pgnFile.name);
    await page.getByRole("button", { name: "Open game", exact: true }).click();
    await expect(page).toHaveURL("/");
    await page.getByRole("tab", { name: "Annotate", exact: true }).click();

    const notation = page.locator("#bottomRight");
    const slotSwitch = page.getByRole("radiogroup", { name: "Comment position", exact: true });
    const editor = page.locator(".tiptap");

    // A mainline move has one comment slot after it and no switch.
    await notation.getByRole("button", { name: "e5", exact: true }).click();
    await expect(slotSwitch).toHaveCount(0);

    await notation.getByRole("button", { name: "c5", exact: true }).click();
    await expect(slotSwitch).toBeVisible();
    await expect(slotSwitch.getByRole("radio", { name: "After move" })).toBeChecked();
    await slotSwitch.getByText("Before move", { exact: true }).click();
    await expect(slotSwitch.getByRole("radio", { name: "Before move" })).toBeChecked();
    await editor.click();
    await page.keyboard.type("Also playable:");

    // The comment stands in front of c5 in the notation, the after slot stays empty.
    const comment = notation.getByText("Also playable:", { exact: true });
    await expect(comment).toBeVisible();
    const commentBox = (await comment.boundingBox())!;
    const moveBox = (await notation
        .getByRole("button", { name: "c5", exact: true })
        .boundingBox())!;
    // In reading order: on a line above the move, or on its line to its left.
    const above = commentBox.y + commentBox.height <= moveBox.y + 1;
    const sameLine =
        commentBox.y < moveBox.y + moveBox.height && moveBox.y < commentBox.y + commentBox.height;
    const leftOnLine = sameLine && commentBox.x + commentBox.width <= moveBox.x + 1;
    expect(above || leftOnLine).toBe(true);
    await slotSwitch.getByText("After move", { exact: true }).click();
    await expect(editor).toHaveText("");
    await slotSwitch.getByText("Before move", { exact: true }).click();
    await expect(editor).toHaveText("Also playable:");

    // Auto-save writes it in front of the variation's first move, inside the parentheses.
    await expect
        .poll(() =>
            page.evaluate(() =>
                window.__E2E_TAURI__
                    .invocations()
                    .filter((item) => item.command === "write_game")
                    .map((item) => (item.args as { pgn: string }).pgn)
                    .at(-1),
            ),
        )
        .toMatch(/\(\{Also playable\\:\} 1\.\.\. c5\s*\)/);

    await page.keyboard.press("Escape");
    await page.mouse.move(0, 0);
    await waitForFontsSettled(page);
    await expect(page.locator(".mantine-RichTextEditor-root")).toHaveScreenshot(
        "annotation-comment-before-editor.png",
    );
    await expect(notation).toHaveScreenshot("annotation-comment-before-notation.png", {
        stylePath: scrollbarFreeScreenshot,
    });
    await expect(page.getByText("Unexpected Tauri IPC command", { exact: false })).toHaveCount(0);
});
