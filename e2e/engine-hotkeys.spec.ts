import {
    expect,
    test,
    playBoardMove,
    bestMovesPayload,
    seedAnalysisEngines,
    type AnalysisRequest,
    moveBackground,
    CURRENT_MOVE_FILL,
} from "./fixtures";
import type { Page } from "@playwright/test";

async function setup(page: Page) {
    await seedAnalysisEngines(page, [
        { id: "hotkey-engine", name: "Hotkey Stockfish", handleId: "hotkey-handle" },
    ]);
    await page.goto("/");
    await page.getByRole("button", { name: /^Analysis Board$/ }).click();
    await page.getByRole("tab", { name: "Analysis", exact: true }).click();
    const panel = page.locator('[data-engine-card-id="hotkey-engine"]');
    await panel.getByRole("button", { name: "Enable engine", exact: true }).click();
    const request = async (moves: string[]) => {
        let latest: AnalysisRequest | undefined;
        await expect
            .poll(async () => {
                latest = await page.evaluate((moves) => {
                    const calls = window.__E2E_TAURI__
                        .invocations()
                        .filter(({ command }) => command === "get_best_moves");
                    const args = calls.at(-1)?.args as AnalysisRequest | undefined;
                    return JSON.stringify(args?.options.moves) === JSON.stringify(moves)
                        ? args
                        : undefined;
                }, moves);
                return latest !== undefined;
            })
            .toBe(true);
        return latest!;
    };
    await request([]);
    return {
        panel,
        request,
        grid: page.getByRole("grid"),
        current: page.locator('[data-notation-current="true"] button'),
    };
}

async function tabToBoard(page: Page) {
    const grid = page.getByRole("grid");
    await grid.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(grid).toBeFocused();
    expect(await grid.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
}

test("pointer move then Space plays the best move and keeps the engine enabled", async ({
    page,
    emitTauriEvent,
}) => {
    const { panel, request, grid, current } = await setup(page);
    await tabToBoard(page);
    await playBoardMove(page, page.locator("cg-board"), "e2", "e4");
    await expect(grid).toBeFocused();
    await expect(current).toHaveText("e4");
    await emitTauriEvent({
        event: "best-moves-payload",
        payload: bestMovesPayload(await request(["e2e4"]), ["c5"], ["c7c5"], 34),
    });
    await expect(panel.getByRole("button", { name: "c5", exact: true })).toBeVisible();
    await page.keyboard.press("Space");
    await expect(current).toHaveText("c5");
    await expect(
        panel.getByRole("button", { name: "Disable engine", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
});

test("Tab-focused board keeps Space and Enter for keyboard move entry", async ({
    page,
    emitTauriEvent,
}) => {
    const { panel, request, current } = await setup(page);
    await emitTauriEvent({
        event: "best-moves-payload",
        payload: bestMovesPayload(await request([]), ["d4"], ["d2d4"], 34),
    });
    await expect(panel.getByRole("button", { name: "d4", exact: true })).toBeVisible();
    await tabToBoard(page);
    await page.keyboard.press("Space");
    await expect(
        page.getByRole("gridcell", { name: "e2, White Pawn, move source selected", exact: true }),
    ).toHaveCount(1);
    await expect(current).toHaveCount(0);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await expect(current).toHaveText("e4");
    await expect(page.locator('[data-notation-current="true"]')).toHaveCount(1);
});

test("Space on the engine button plays a current move and suppresses its native activation", async ({
    page,
    emitTauriEvent,
}) => {
    const { panel, request, current } = await setup(page);
    await emitTauriEvent({
        event: "best-moves-payload",
        payload: bestMovesPayload(await request([]), ["e4"], ["e2e4"], 34),
    });
    await expect(panel.getByRole("button", { name: "e4", exact: true })).toBeVisible();
    const toggle = panel.getByRole("button", { name: "Disable engine", exact: true });
    await expect(toggle).toBeFocused();
    await page.keyboard.press("Space");
    await expect(current).toHaveText("e4");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(toggle).toBeFocused();
});

test("Space without lines preserves the engine button's native activation", async ({ page }) => {
    const { panel, current } = await setup(page);
    await expect(panel.getByRole("button", { name: "Disable engine", exact: true })).toBeFocused();
    await page.keyboard.press("Space");
    await expect(panel.getByRole("button", { name: "Enable engine", exact: true })).toHaveAttribute(
        "aria-pressed",
        "false",
    );
    await expect(current).toHaveCount(0);
});

test("X toggles the Crosshair state and Shift+C navigates to the previous branch", async ({
    page,
}) => {
    const { panel, current } = await setup(page);
    const threat = panel.getByRole("button", { name: "Check the opponent's threat", exact: true });
    const badge = panel.getByTestId("threat-badge");
    await expect(badge).toHaveCount(0);
    await page.keyboard.press("x");
    await expect(threat).toHaveAttribute("aria-pressed", "true");
    await expect(badge).toHaveText("Threat");
    await page.keyboard.press("x");
    await expect(threat).toHaveAttribute("aria-pressed", "false");
    await expect(badge).toHaveCount(0);
    await playBoardMove(page, page.locator("cg-board"), "d2", "d4");
    await expect(current).toHaveText("d4");
    await page.getByRole("button", { name: "Go to start", exact: true }).click();
    await playBoardMove(page, page.locator("cg-board"), "e2", "e4");
    await expect(current).toHaveText("e4");
    await page.keyboard.press("Shift+c");
    await expect(current).toHaveText("d4");
    await expect(threat).toHaveAttribute("aria-pressed", "false");
});

test("with the hover preview off, a hovered engine-line move takes the warm hover on its inset row", async ({
    page,
    emitTauriEvent,
}) => {
    await page.addInitScript(() =>
        localStorage.setItem("preview-board-on-hover", JSON.stringify(false)),
    );
    const { panel, request } = await setup(page);
    await emitTauriEvent({
        event: "best-moves-payload",
        payload: bestMovesPayload(await request([]), ["d4", "d5"], ["d2d4", "d7d5"], 20),
    });
    const move = panel.getByRole("button", { name: "d5", exact: true });
    await move.hover();
    await expect(page.getByTestId("engine-line-preview")).toHaveCount(0);
    await expect(move).not.toHaveAttribute("aria-current", "true");
    const hovered = await moveBackground(move, "var(--cf-move-hover)");
    expect(hovered.actual).toBe(hovered.expected);
});

test("move keys step an open engine-line preview board in place and leave the game alone", async ({
    page,
    emitTauriEvent,
}) => {
    const { panel, request, current } = await setup(page);
    await playBoardMove(page, page.locator("cg-board").first(), "e2", "e4");
    await expect(current).toHaveText("e4");
    await page.getByRole("button", { name: "Go to start", exact: true }).click();
    await expect(current).toHaveCount(0);
    await emitTauriEvent({
        event: "best-moves-payload",
        payload: bestMovesPayload(
            await request([]),
            ["d4", "d5", "c4", "e6"],
            ["d2d4", "d7d5", "c2c4", "e7e6"],
            20,
        ),
    });
    const move = (san: string) => panel.getByRole("button", { name: san, exact: true });
    await move("d4").hover();
    const preview = page.getByTestId("engine-line-preview");
    await expect(preview).toBeVisible();
    const opened = await preview.boundingBox();

    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(move("c4")).toHaveAttribute("aria-current", "true");
    await expect(current).toHaveCount(0);
    expect(await preview.boundingBox()).toEqual(opened);
    // The stepped move is not under the pointer, so it shows the resting gold fill.
    const stepped = await moveBackground(move("c4"), CURRENT_MOVE_FILL);
    expect(stepped.actual).toBe(stepped.expected);

    await page.keyboard.press("ArrowLeft");
    await expect(move("d5")).toHaveAttribute("aria-current", "true");
    await expect(current).toHaveCount(0);

    // Once the pointer leaves the line the board closes, and the keys move the game again.
    await page.mouse.move(5, 5);
    await expect(preview).toHaveCount(0);
    await page.keyboard.press("ArrowRight");
    await expect(current).toHaveText("e4");
});
