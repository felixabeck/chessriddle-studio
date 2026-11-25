import type { Locator, Page } from "@playwright/test";
import {
    assertNothingClipped,
    expect,
    goToSettings,
    test,
    waitForTransitionsSettled,
} from "./fixtures";

async function openBoardSettings(page: Page) {
    await page.goto("/");
    await goToSettings(page);
    await page.getByRole("tab", { name: "Board", exact: true }).click();
    const look = page.locator('[data-settings-section="look"]');
    const preview = look.getByTestId("board-settings-preview");
    await expect(preview.locator("cg-board")).toBeVisible();
    return { look, preview };
}

async function chooseOption(page: Page, select: string, option: string) {
    await page.getByRole("textbox", { name: select, exact: true }).click();
    await page.getByRole("option", { name: option, exact: true }).click();
}

/** The destination squares whose centre lies inside the preview window (d3, not d4 above it). */
async function destinationsInWindow(preview: Locator) {
    return preview.evaluate((element) => {
        const frame = element.getBoundingClientRect();
        return [...element.querySelectorAll<HTMLElement>("cg-board square.move-dest")]
            .filter((square) => getComputedStyle(square).visibility !== "hidden")
            .map((square) => square.getBoundingClientRect())
            .filter((box) => {
                const y = box.top + box.height / 2;
                return y > frame.top && y < frame.bottom;
            })
            .map((box) => ({ x: box.left + box.width / 2, y: box.top + box.height / 2 }));
    });
}

test("board-settings-preview: the Look card shows ranks 1-3 with the pawn's own destination and follows the settings", async ({
    page,
}) => {
    const { preview } = await openBoardSettings(page);

    // White to move: the selected d2 pawn shows d3 in the window, never premove targets. Chessground
    // hides a square it no longer needs rather than removing it.
    await expect.poll(() => destinationsInWindow(preview)).toHaveLength(1);
    await expect(preview.locator("cg-board square.premove-dest:visible")).toHaveCount(0);
    const lastMove = preview.locator("cg-board square.last-move:visible");
    await expect(lastMove).toHaveCount(2);

    // The window holds exactly three ranks of the painted board.
    const { windowHeight, boardHeight } = await preview.evaluate((element) => ({
        windowHeight: element.getBoundingClientRect().height,
        boardHeight: element.querySelector("cg-container")!.getBoundingClientRect().height,
    }));
    expect(windowHeight).toBeCloseTo((boardHeight * 3) / 8, 0);

    // A mounted board redraws its coordinate labels when the mode changes.
    await chooseOption(page, "Coordinates", "On the edge");
    await expect(preview.locator("coords.ranks")).toHaveCount(1);
    await expect(preview.locator("coords.files")).toHaveCount(1);
    await chooseOption(page, "Coordinates", "On all squares");
    await expect(preview.locator("coords.squares").first()).toBeAttached();
    await expect(preview.locator("coords.ranks")).toHaveCount(0);
    await chooseOption(page, "Coordinates", "No");
    await expect(preview.locator("coords")).toHaveCount(0);

    await page.getByRole("switch", { name: "Piece Destinations", exact: true }).uncheck();
    await expect.poll(() => destinationsInWindow(preview)).toHaveLength(0);
    await page.getByRole("textbox", { name: "Move Highlight Color", exact: true }).fill("#0095FF");
    for (const square of await lastMove.all()) {
        await expect(square).toHaveCSS("background-color", "rgba(0, 149, 255, 0.4)");
    }
    const opacity = page.getByRole("slider", { name: "Move Highlight Opacity", exact: true });
    await opacity.focus();
    await opacity.press("ArrowRight");
    for (const square of await lastMove.all()) {
        await expect(square).toHaveCSS("background-color", "rgba(0, 149, 255, 0.45)");
    }
    await page.getByRole("switch", { name: "Move Highlight", exact: true }).uncheck();
    await expect(lastMove).toHaveCount(0);
});

test("board-settings-preview: the board image, wood texture, piece set and piece size change the preview in place", async ({
    page,
}) => {
    const { preview } = await openBoardSettings(page);
    const wrap = preview.locator(".cg-wrap");
    const pawn = preview.locator("piece.pawn.white").first();
    const cssVar = (name: string) =>
        wrap.evaluate(
            (element, property) => getComputedStyle(element).getPropertyValue(property),
            name,
        );

    await expect.poll(() => cssVar("--board-texture")).toContain("wood4-square.png");
    await page.getByRole("switch", { name: "Wood Texture", exact: true }).uncheck();
    await expect.poll(() => cssVar("--board-texture")).toBe("none");

    await chooseOption(page, "Board Image", "blue2");
    await expect.poll(() => cssVar("--board-image")).toContain("/board/blue2.jpg");

    const pieceImage = () => pawn.evaluate((element) => getComputedStyle(element).backgroundImage);
    const before = await pieceImage();
    await chooseOption(page, "Piece Set", "Alpha");
    // Piece sets are inline images, so the proof is that the image changed.
    await expect.poll(pieceImage).not.toBe(before);

    const padding = () => pawn.evaluate((element) => getComputedStyle(element).paddingTop);
    const fullSize = await padding();
    const size = page.getByRole("slider", { name: "Piece Size", exact: true });
    await size.focus();
    await size.press("Home");
    await expect.poll(padding).not.toBe(fullSize);
});

test("board-settings-preview: the destination square takes no pointer and the crop is the only cut", async ({
    page,
}) => {
    const { look, preview } = await openBoardSettings(page);
    const [d3] = await destinationsInWindow(preview);
    // The whole preview leaves the pointer to what lies beneath it, its destination square included.
    const hitInsidePreview = await preview.evaluate((element, { x, y }) => {
        const hit = document.elementFromPoint(x, y);
        return hit !== null && element.contains(hit);
    }, d3);
    expect(hitInsidePreview).toBe(false);

    await waitForTransitionsSettled(page);
    await assertNothingClipped(look, { mode: "reachable" });
    // The marked window itself is still judged: pushed before its container's content, it reports.
    await preview.evaluate((element) => (element.style.marginTop = "-100000px"));
    await expect(assertNothingClipped(look, { mode: "reachable" })).rejects.toThrow(
        /boardPreview[^;]*starts at/,
    );
    await preview.evaluate((element) => (element.style.marginTop = ""));
    // And the opt-out is the marker alone: without it the same window is reported.
    await preview.evaluate((element) => element.removeAttribute("data-deliberate-crop"));
    await expect(assertNothingClipped(look, { mode: "reachable" })).rejects.toThrow(
        /content clipped/,
    );
});

test("board-settings-preview: pixels", async ({ page }) => {
    const { preview } = await openBoardSettings(page);
    await chooseOption(page, "Coordinates", "On the edge");
    await expect(preview.locator("coords.files")).toHaveCount(1);
    await waitForTransitionsSettled(page);
    await expect(preview).toHaveScreenshot("board-settings-preview.png");
});

test("board-settings-preview: a playable board's destination square still takes the pointer", async ({
    page,
}) => {
    await page.goto("/");
    await page.getByRole("button", { name: /^Analysis Board$/ }).click();
    const board = page.locator(".cg-wrap.manipulable").first();
    await expect(board.locator("cg-board")).toBeVisible();
    // Pieces leave the pointer to the board, so the click goes to the pawn's place on it.
    const pawn = (await board.locator("piece.pawn.white").first().boundingBox())!;
    await page.mouse.click(pawn.x + pawn.width / 2, pawn.y + pawn.height / 2);
    const destination = board.locator("cg-board square.move-dest:visible").first();
    await expect(destination).toHaveCSS("pointer-events", "auto");
});
