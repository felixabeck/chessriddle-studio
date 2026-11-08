import {
    expect,
    filesWorkspaceCommands,
    filesWorkspaceFixture,
    localRequestFailure,
    pgnFileCommands,
    preserveStorageForReload,
    selectFilesTreeRow,
    test,
    waitForTransitionsSettled,
} from "./fixtures";
import type { Page, Request } from "@playwright/test";

const TEXTURE_URL = /^url\("[^"]*\/board\/wood4-square\.png"\)/;
const BOARD_IMAGE_URL = /url\("[^"]*\/board\/chessriddle\.svg"\)$/;
/** Releases a held tile response if the page never abandons it, so a regression fails, not hangs. */
const HELD_RESPONSE_DEADLINE_MS = 10_000;
/** Lets the held requests reach the network layer before the page cancels them. */
const CANCEL_AFTER_MS = 200;

async function openBoard(page: Page) {
    await page.goto("/");
    await page.getByRole("button", { name: /^open$/i }).click();
    const board = page.locator("cg-board").first();
    await expect(board).toBeVisible();
    return board;
}

async function openAppearanceTab(page: Page) {
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Appearance", exact: true }).click();
    const woodTexture = page.getByRole("switch", { name: "Wood texture", exact: true });
    await expect(woodTexture).toBeVisible();
    return woodTexture;
}

test("board-wood-texture: the real stylesheet layers the tile over the board image, and the switch turns it off", async ({
    page,
}) => {
    const board = await openBoard(page);
    // The atom hydrates on mount, so every read of the computed style retries.
    await expect(board).toHaveCSS("background-image", new RegExp(`${TEXTURE_URL.source}, .*`));
    await expect(board).toHaveCSS("background-image", new RegExp(`, ${BOARD_IMAGE_URL.source}`));
    await expect(board).toHaveCSS("background-size", "12.5% 12.5%, cover");
    await expect(board).toHaveCSS("background-blend-mode", "soft-light, normal");

    const woodTexture = await openAppearanceTab(page);
    await expect(woodTexture).toBeChecked();
    await woodTexture.uncheck();
    await expect(woodTexture).not.toBeChecked();
    await expect
        .poll(() => page.evaluate(() => localStorage.getItem("board-wood-texture")))
        .toBe("false");

    // A navigation by URL clears storage, so the stored value is read back by reloading the board
    // page itself; the preserve flag is consumed by that one load.
    await page.getByRole("link", { name: "Board", exact: true }).click();
    await expect(board).toBeVisible();
    await preserveStorageForReload(page);
    await expect(board).toBeVisible();
    await expect(board).toHaveCSS("background-image", /^none, url\(/);
    await expect(board).toHaveCSS("background-image", new RegExp(`, ${BOARD_IMAGE_URL.source}`));
    await expect(board).toHaveCSS("background-size", "12.5% 12.5%, cover");
    await expect(board).toHaveCSS("background-blend-mode", "soft-light, normal");
    expect(await page.evaluate(() => localStorage.getItem("board-wood-texture"))).toBe("false");
});

test("board-wood-texture: Appearance switch track labels pass the accessibility scan on and off", async ({
    page,
    assertAccessible,
}) => {
    await page.goto("/settings");
    const woodTexture = await openAppearanceTab(page);
    await expect(woodTexture).toBeChecked();
    // The sidebar link's tooltip fades out once the pointer leaves it; axe must not sample it.
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await waitForTransitionsSettled(page);
    await assertAccessible();

    await woodTexture.uncheck();
    await expect(woodTexture).not.toBeChecked();
    await waitForTransitionsSettled(page);
    await assertAccessible();
});

test("board-wood-texture: wood4-square.png is the top-left 128x128 of wood4.jpg", async ({
    page,
}) => {
    await page.goto("/");
    const result = await page.evaluate(async () => {
        const load = (src: string) =>
            new Promise<HTMLImageElement>((resolve, reject) => {
                const image = new Image();
                image.onload = () => resolve(image);
                image.onerror = () => reject(new Error(`could not load ${src}`));
                image.src = src;
            });
        const [tile, source] = await Promise.all([
            load("/board/wood4-square.png"),
            load("/board/wood4.jpg"),
        ]);
        const topLeft = (image: HTMLImageElement) => {
            const canvas = document.createElement("canvas");
            canvas.width = 128;
            canvas.height = 128;
            const context = canvas.getContext("2d")!;
            context.drawImage(image, 0, 0, 128, 128, 0, 0, 128, 128);
            return context.getImageData(0, 0, 128, 128).data;
        };
        const tilePixels = topLeft(tile);
        const sourcePixels = topLeft(source);
        let maxDifference = 0;
        let lowest = 255;
        let highest = 0;
        for (let index = 0; index < tilePixels.length; index += 1) {
            maxDifference = Math.max(
                maxDifference,
                Math.abs(tilePixels[index] - sourcePixels[index]),
            );
            // The crop must carry grain, or "no difference" would prove nothing.
            if (index % 4 === 0) {
                lowest = Math.min(lowest, sourcePixels[index]);
                highest = Math.max(highest, sourcePixels[index]);
            }
        }
        return {
            tile: [tile.naturalWidth, tile.naturalHeight],
            source: [source.naturalWidth, source.naturalHeight],
            maxDifference,
            spread: highest - lowest,
        };
    });
    expect(result.tile).toEqual([128, 128]);
    expect(result.source).toEqual([1024, 1024]);
    expect(result.spread).toBeGreaterThan(10);
    // JPEG decoder rounding between ImageMagick and Chromium; the crop itself is lossless.
    expect(result.maxDifference).toBeLessThanOrEqual(2);
});

test("board-wood-texture: arrows from PGN drawings keep finite coordinates when the stored preference is off", async ({
    page,
    mockScenario,
}) => {
    // A stored value that differs from the atom default hydrates on mount and re-renders the board.
    // Chessground must not apply shapes against the 0x0 bounds it measured at creation.
    await page.addInitScript(() => localStorage.setItem("board-wood-texture", "false"));
    const drawings = "[%cal Ra2a4,Gb2b4,Yc2c4,Bd2d4,Oe2e4,Cf2f4] [%csl Ra5,Gb5,Yc5,Bd5,Oe5,Cf5]";
    const pgn = `[Event "Six colors"]\n[Result "*"]\n\n{${drawings}} 1. e4 *`;
    await mockScenario({
        commands: filesWorkspaceCommands([[filesWorkspaceFixture.pgnFile]], {
            ...pgnFileCommands,
            read_games: {
                result: [
                    { pgn, stamp: "e".repeat(64), revision: "e2e-pgn-revision", present: true },
                ],
            },
            read_game: {
                result: { pgn, stamp: "e".repeat(64), revision: "e2e-pgn-revision", present: true },
            },
            // Mock only native lexing. The real parsePGN and Chessground render the imported data.
            lex_pgn: {
                result: [
                    { type: "Header", value: { tag: "Event", value: "Six colors" } },
                    { type: "Header", value: { tag: "Result", value: "*" } },
                    { type: "Comment", value: drawings },
                    { type: "San", value: "e4" },
                    { type: "Outcome", value: "*" },
                ],
            },
        }),
    });
    // Holding the default-tile response keeps that fetch pending if the first board requests it
    // before the stored "off" hydrates. The hold is released when the page abandons the tile
    // (or after HELD_RESPONSE_DEADLINE_MS). Whether the tile is requested and abandoned depends
    // on timing, so the test does not wait for it (f-20261105-07). The test "the page fixture
    // accepts an abandoned image fetch" proves the exemption end to end.
    const textureFailed = new Promise<void>((resolve) => {
        page.on("requestfailed", (request) => {
            if (request.url().endsWith("/board/wood4-square.png")) {
                resolve();
            }
        });
    });
    await page.route("**/board/wood4-square.png", async (route) => {
        await Promise.race([
            textureFailed,
            new Promise((resolve) => setTimeout(resolve, HELD_RESPONSE_DEADLINE_MS)),
        ]);
        await route.continue().catch(() => undefined);
    });
    await page.goto("/library");
    await page.getByRole("button", { name: /choose collection/i }).click();
    await selectFilesTreeRow(page, filesWorkspaceFixture.pgnFile.name);
    await page.getByRole("button", { name: "Open game", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.getByRole("button", { name: "Go to start", exact: true }).click();
    const board = page.locator(".cg-wrap");
    await expect(board).toBeVisible();
    // The seed took effect: the texture layer is none.
    await expect(board.locator("cg-board")).toHaveCSS("background-image", /^none, url\(/);

    const arrows = board.locator("svg.cg-shapes g[cgHash] line");
    await expect(arrows).toHaveCount(6);
    await expect(board.locator("svg.cg-shapes g[cgHash] circle")).toHaveCount(6);
    const coordinates = await arrows.evaluateAll((lines) =>
        lines.flatMap((line) =>
            ["x1", "y1", "x2", "y2"].map((name) => Number(line.getAttribute(name))),
        ),
    );
    expect(coordinates).toHaveLength(24);
    expect(coordinates.every(Number.isFinite)).toBe(true);
});

test("board-wood-texture: the browser-failure check exempts only abandoned image fetches", async ({
    browser,
    baseURL,
}) => {
    // The fixture's classifier, fed the real failed requests Chromium reports. A separate context
    // keeps these deliberate failures away from the page fixture's own failure check.
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    await page.route("**/board/held.*", () => undefined);
    await page.route("**/board/refused.png", (route) => route.abort("connectionrefused"));
    await page.goto("/board/wood4.jpg");
    const failed: Request[] = [];
    page.on("requestfailed", (request) => failed.push(request));
    await page.evaluate((cancelAfterMs) => {
        const controller = new AbortController();
        void fetch("/board/held.json", { signal: controller.signal }).catch(() => undefined);
        const held = new Image();
        held.src = "/board/held.png";
        const refused = new Image();
        refused.src = "/board/refused.png";
        setTimeout(() => {
            controller.abort();
            held.src = "";
        }, cancelAfterMs);
    }, CANCEL_AFTER_MS);
    await expect.poll(() => failed.length).toBe(3);
    const origin = new URL(page.url()).origin;
    const byPath = Object.fromEntries(
        failed.map((request) => [
            new URL(request.url()).pathname,
            {
                type: request.resourceType(),
                error: request.failure()?.errorText,
                failure: localRequestFailure(request, origin),
            },
        ]),
    );
    expect(byPath).toEqual({
        "/board/held.json": {
            type: "fetch",
            error: "net::ERR_ABORTED",
            failure: `Failed local request: ${origin}/board/held.json`,
        },
        "/board/held.png": { type: "image", error: "net::ERR_ABORTED", failure: null },
        "/board/refused.png": {
            type: "image",
            error: "net::ERR_CONNECTION_REFUSED",
            failure: `Failed local request: ${origin}/board/refused.png`,
        },
    });
    await context.close();
});

test("board-wood-texture: the page fixture accepts an abandoned image fetch", async ({ page }) => {
    // If the fixture reported this abort as a browser failure the test would fail at fixture
    // teardown (f-20261102-06).
    await page.route("**/board/held.png", () => undefined);
    await page.goto("/board/wood4.jpg");
    const abandoned = new Promise<string | undefined>((resolve) => {
        page.on("requestfailed", (request) => {
            if (request.url().endsWith("/board/held.png")) {
                resolve(request.failure()?.errorText);
            }
        });
    });
    await page.evaluate((cancelAfterMs) => {
        const held = new Image();
        held.src = "/board/held.png";
        setTimeout(() => {
            held.src = "";
        }, cancelAfterMs);
    }, CANCEL_AFTER_MS);
    expect(await abandoned).toBe("net::ERR_ABORTED");
});

test("board-wood-texture: the default board shows the wood grain", async ({ page }) => {
    const board = await openBoard(page);
    await expect(board).toHaveCSS("background-image", TEXTURE_URL);
    await page.mouse.move(0, 0);
    // Texture-on against texture-off, both the start-position board (`.cg-wrap`), measured in the
    // container: at 0.2 (Playwright's default, not a project setting) and at 0.08 the two boards
    // match, so the default threshold could never tell them apart. 0.06 flags 29195 and 0.05 flags
    // 75026 of 313040 pixels.
    await expect(page.locator(".cg-wrap")).toHaveScreenshot("board-wood-texture-on.png", {
        threshold: 0.05,
    });
});

test("board-wood-texture: the board with the texture stored off renders without the grain", async ({
    page,
}) => {
    await page.addInitScript(() => localStorage.setItem("board-wood-texture", "false"));
    const board = await openBoard(page);
    await expect(board).toHaveCSS("background-image", /^none, url\(/);
    await page.mouse.move(0, 0);
    await expect(page.locator(".cg-wrap")).toHaveScreenshot("board-wood-texture-off.png", {
        threshold: 0.05,
    });
});

test("board-wood-texture: the exported board snapshot carries the wood grain, and drops it when off", async ({
    page,
    mockScenario,
}) => {
    await mockScenario({ commands: { save_board_snapshot: { result: null } } });
    const board = await openBoard(page);
    await expect(board).toHaveCSS("background-image", TEXTURE_URL);
    await page.mouse.move(0, 0);

    // The fixture records every IPC call; the exported PNG is the `bytes` of save_board_snapshot.
    const invocations = () =>
        page.evaluate(() =>
            window.__E2E_TAURI__
                .invocations()
                .filter(({ command }) => command === "save_board_snapshot")
                .map(({ args }) => (args as { bytes: number[] }).bytes),
        );

    const exportedBytes = async () => {
        const takeSnapshot = page.getByRole("button", { name: "Take Snapshot", exact: true });
        await expect(takeSnapshot).toBeEnabled();
        const before = (await invocations()).length;
        await takeSnapshot.click();
        try {
            await expect
                .poll(async () => (await invocations()).length, { timeout: 6_000 })
                .toBeGreaterThan(before);
        } catch {
            // Under load the click can be lost after the route change. Retry once only, after
            // a window long enough that a slow export is not duplicated.
            await takeSnapshot.click();
            await expect
                .poll(async () => (await invocations()).length, { timeout: 6_000 })
                .toBeGreaterThan(before);
        }
        return (await invocations()).at(-1)!;
    };
    const withTexture = await exportedBytes();

    const woodTexture = await openAppearanceTab(page);
    await woodTexture.uncheck();
    await expect(woodTexture).not.toBeChecked();
    await page.getByRole("link", { name: "Board", exact: true }).click();
    await expect(board).toHaveCSS("background-image", /^none, url\(/);
    await page.mouse.move(0, 0);
    const withoutTexture = await exportedBytes();

    const result = await page.evaluate(
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
            let different = 0;
            for (let index = 0; index < first.data.length; index += 4) {
                const distance = Math.max(
                    Math.abs(first.data[index] - second.data[index]),
                    Math.abs(first.data[index + 1] - second.data[index + 1]),
                    Math.abs(first.data[index + 2] - second.data[index + 2]),
                );
                if (distance > 0) different += 1;
            }
            return {
                sizes: [
                    [first.width, first.height],
                    [second.width, second.height],
                ],
                pixels: first.width * first.height,
                different,
            };
        },
        [withTexture, withoutTexture],
    );
    expect(result.sizes[0]).toEqual(result.sizes[1]);
    // The grain covers every square, so most pixels of the board differ once it is exported on.
    expect(result.different).toBeGreaterThan(result.pixels / 2);
});
