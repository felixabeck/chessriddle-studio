import {
    expect,
    playBoardMove,
    preserveStorageForReload,
    test,
    whitePawnSquares,
} from "./fixtures";
import type { Locator, Page } from "@playwright/test";

const CENTRED_70_INSET = (1 - 0.7) / 2;

async function openBoard(page: Page) {
    await page.goto("/");
    await page.getByRole("button", { name: /^Analysis Board$/ }).click();
    const board = page.locator("cg-board").first();
    await expect(board).toBeVisible();
    return board;
}

async function openAppearanceTab(page: Page) {
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Appearance", exact: true }).click();
}

function boardPiece(page: Page, selector = "piece.white.king") {
    return page.locator(`.cg-wrap ${selector}`).first();
}

async function pieceLayout(piece: Locator) {
    return piece.evaluate((element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        const board = (element.closest("cg-container") ??
            element.closest(".cg-wrap"))!.getBoundingClientRect();
        const square = board.width / 8;
        return {
            width: box.width,
            height: box.height,
            square,
            paddingTop: Number.parseFloat(style.paddingTop),
            paddingRight: Number.parseFloat(style.paddingRight),
            paddingBottom: Number.parseFloat(style.paddingBottom),
            paddingLeft: Number.parseFloat(style.paddingLeft),
        };
    });
}

function integerClip(box: { x: number; y: number; width: number; height: number }) {
    return {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
    };
}

async function piecePaintBounds(page: Page, piece: Locator) {
    const box = (await piece.boundingBox())!;
    const clip = integerClip(box);
    await page.mouse.move(0, 0);
    const occupied = [...new Uint8Array(await page.screenshot({ clip, animations: "disabled" }))];
    await piece.evaluate((element) => {
        (element as HTMLElement).style.visibility = "hidden";
    });
    const empty = [...new Uint8Array(await page.screenshot({ clip, animations: "disabled" }))];
    await piece.evaluate((element) => {
        (element as HTMLElement).style.visibility = "";
    });
    return page.evaluate(
        async ([on, off]) => {
            const decode = async (bytes: number[]) => {
                const bitmap = await createImageBitmap(
                    new Blob([new Uint8Array(bytes)], { type: "image/png" }),
                );
                const canvas = document.createElement("canvas");
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
                const context = canvas.getContext("2d")!;
                context.drawImage(bitmap, 0, 0);
                return context.getImageData(0, 0, bitmap.width, bitmap.height);
            };
            const [first, second] = await Promise.all([decode(on), decode(off)]);
            let minX = first.width;
            let minY = first.height;
            let maxX = -1;
            let maxY = -1;
            for (let y = 0; y < first.height; y += 1) {
                for (let x = 0; x < first.width; x += 1) {
                    const index = (y * first.width + x) * 4;
                    const changed =
                        first.data[index] !== second.data[index] ||
                        first.data[index + 1] !== second.data[index + 1] ||
                        first.data[index + 2] !== second.data[index + 2] ||
                        first.data[index + 3] !== second.data[index + 3];
                    if (changed) {
                        minX = Math.min(minX, x);
                        minY = Math.min(minY, y);
                        maxX = Math.max(maxX, x);
                        maxY = Math.max(maxY, y);
                    }
                }
            }
            return {
                paintDetected: maxX >= 0,
                minX,
                minY,
                maxX,
                maxY,
                width: first.width,
                height: first.height,
            };
        },
        [occupied, empty] as [number[], number[]],
    );
}

async function setPieceSizeToSeventy(page: Page) {
    const slider = page.getByRole("slider", { name: "Piece Size", exact: true });
    await slider.scrollIntoViewIfNeeded();
    await expect(slider).toBeVisible();
    await slider.focus();
    await page.keyboard.press("Home");
    await expect(slider).toHaveAttribute("aria-valuenow", "70");
    return slider;
}

test("piece-size: default board pieces fill the square with cover and no padding", async ({
    page,
}) => {
    await openBoard(page);
    const piece = boardPiece(page);
    await expect(piece).toBeVisible();
    await expect(piece).toHaveCSS("background-size", "cover");
    const layout = await pieceLayout(piece);
    expect(layout.paddingTop).toBe(0);
    expect(layout.paddingRight).toBe(0);
    expect(layout.paddingBottom).toBe(0);
    expect(layout.paddingLeft).toBe(0);
    expect(Math.abs(layout.width - layout.square)).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.height - layout.square)).toBeLessThanOrEqual(1);
});

test("piece-size: Appearance slider stores 70, insets the image, keeps click-moves, and survives reload", async ({
    page,
}) => {
    const board = await openBoard(page);
    await openAppearanceTab(page);
    const slider = await setPieceSizeToSeventy(page);
    await expect(slider).toHaveAttribute("aria-valuenow", "70");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("piece-size"))).toBe("70");

    await page.getByRole("link", { name: "Board", exact: true }).click();
    await expect(board).toBeVisible();
    const piece = boardPiece(page);
    await expect(piece).toHaveCSS("background-size", "cover");
    await expect(piece).toHaveCSS("background-origin", "content-box");
    await expect(piece).toHaveCSS("background-clip", "content-box");
    const layout = await pieceLayout(piece);
    expect(Math.abs(layout.width - layout.square)).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.height - layout.square)).toBeLessThanOrEqual(1);
    const contentWidth = layout.width - layout.paddingLeft - layout.paddingRight;
    const contentHeight = layout.height - layout.paddingTop - layout.paddingBottom;
    expect(Math.abs(contentWidth - 0.7 * layout.square)).toBeLessThanOrEqual(1);
    expect(Math.abs(contentHeight - 0.7 * layout.square)).toBeLessThanOrEqual(1);

    await playBoardMove(page, board, "e2", "e4");
    await expect.poll(() => whitePawnSquares(page.locator(".cg-wrap").first())).toContain("e4");

    await preserveStorageForReload(page);
    await expect(board).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("piece-size"))).toBe("70");
    const reloaded = boardPiece(page);
    await expect(reloaded).toHaveCSS("background-origin", "content-box");
    const reloadedLayout = await pieceLayout(reloaded);
    const reloadedContent =
        reloadedLayout.width - reloadedLayout.paddingLeft - reloadedLayout.paddingRight;
    expect(Math.abs(reloadedContent - 0.7 * reloadedLayout.square)).toBeLessThanOrEqual(1);
});

async function selectMeridaPieceSet(page: Page) {
    const pieceSet = page.getByRole("button", { name: "Piece Set", exact: true });
    await pieceSet.scrollIntoViewIfNeeded();
    await pieceSet.click();
    const merida = page.getByRole("option", { name: "Merida", exact: true });
    await merida.click();
    await expect(pieceSet).toHaveText("Merida");
    await page.waitForFunction(() =>
        [...document.querySelectorAll('link[rel="stylesheet"]')].some((element) => {
            const link = element as HTMLLinkElement;
            return link.href.includes("/pieces/merida.css") && link.sheet !== null;
        }),
    );
}

test("piece-size: merida paint at 100% extends outside the centred 70% box, and at 70% lies inside", async ({
    page,
}) => {
    const board = await openBoard(page);
    await openAppearanceTab(page);
    await selectMeridaPieceSet(page);

    await page.getByRole("link", { name: "Board", exact: true }).click();
    await expect(board).toBeVisible();
    const queen = boardPiece(page, "piece.white.queen");
    await expect(queen).toBeVisible();
    const atFull = await piecePaintBounds(page, queen);
    expect(atFull.paintDetected).toBe(true);
    const insetX = CENTRED_70_INSET * atFull.width;
    const insetY = CENTRED_70_INSET * atFull.height;
    expect(
        atFull.minX < insetX ||
            atFull.minY < insetY ||
            atFull.maxX > atFull.width - insetX ||
            atFull.maxY > atFull.height - insetY,
    ).toBe(true);

    await openAppearanceTab(page);
    await setPieceSizeToSeventy(page);
    await page.getByRole("link", { name: "Board", exact: true }).click();
    await expect(board).toBeVisible();
    const shrunkQueen = boardPiece(page, "piece.white.queen");
    await expect(shrunkQueen).toBeVisible();
    const atSeventy = await piecePaintBounds(page, shrunkQueen);
    expect(atSeventy.paintDetected).toBe(true);
    const seventyInsetX = CENTRED_70_INSET * atSeventy.width;
    const seventyInsetY = CENTRED_70_INSET * atSeventy.height;
    expect(atSeventy.minX).toBeGreaterThanOrEqual(seventyInsetX - 1);
    expect(atSeventy.minY).toBeGreaterThanOrEqual(seventyInsetY - 1);
    expect(atSeventy.maxX).toBeLessThanOrEqual(atSeventy.width - seventyInsetX + 1);
    expect(atSeventy.maxY).toBeLessThanOrEqual(atSeventy.height - seventyInsetY + 1);
});
