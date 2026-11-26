import { test, expect, activeWorkspaceTab, createLiveGameState } from "./fixtures";
import { deserializeStorageValue } from "../src/state/store/debouncedStorage";

const liveState = createLiveGameState();
const moves = [
    {
        uci: "e2e4",
        san: "e4",
        clock: null,
        whiteTime: null,
        blackTime: null,
        fenAfter: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    },
];
const result = {
    type: "interrupted",
    reason: "engineFailure",
    snapshot: {
        kind: "protocol-failure",
        exitStatus: { code: 1, signal: null },
        reason: "Invalid engine command",
        entries: [
            { type: "infoString", value: "Invalid engine command" },
            { type: "stderr", value: "Safe final engine diagnostic" },
            { type: "truncated" },
        ],
    },
};

for (const delivery of ["event", "snapshot"] as const) {
    test(`game-interruption: ${delivery} preserves the board without a chess result`, async ({
        page,
        mockScenario,
        emitTauriEvent,
    }) => {
        await page.clock.setFixedTime(new Date("2026-10-12T12:00:00Z"));
        if (delivery === "event") {
            await page.addInitScript(() =>
                localStorage.setItem("erase-drawables-on-click", "false"),
            );
        }
        await page.addInitScript(() =>
            localStorage.setItem(
                "engines",
                JSON.stringify([
                    {
                        type: "local",
                        id: "game-engine",
                        name: "E2E engine",
                        version: "1",
                        filename: "engine",
                        handle: { id: { id: "game-engine-handle" }, kind: "engine" },
                        settings: [],
                        go: { t: "Depth", c: 1 },
                    },
                ]),
            ),
        );
        await mockScenario({
            commands: {
                start_game: { gameState: liveState },
                get_game_state: { gameState: liveState },
            },
        });
        await page.goto("/");
        await page.getByRole("button", { name: "Play", exact: true }).click();
        await page.getByText("Engine", { exact: true }).last().click();
        await page.getByRole("button", { name: "Start game", exact: true }).click();
        await expect(page.getByRole("button", { name: "Resign", exact: true })).toBeVisible();
        const invocations = await page.evaluate(() => window.__E2E_TAURI__.invocations());
        const gameId = invocations.find(({ command }) => command === "start_game")?.args.gameId;
        expect(gameId).toBeTruthy();
        const terminal = { ...liveState, revision: 3, moves, status: { finished: { result } } };
        if (delivery === "snapshot") {
            await page.evaluate(
                (gameState) =>
                    window.__E2E_TAURI__.configure({
                        commands: {
                            get_game_state: { gameState },
                        },
                    }),
                terminal,
            );
        } else {
            await emitTauriEvent({
                event: "game-over-event",
                payload: {
                    gameId,
                    session: 1,
                    revision: 3,
                    result,
                    moves,
                },
            });
        }
        const notice = page.getByRole("alert");
        await expect(notice).toHaveText("Game interrupted: Invalid engine command");
        await emitTauriEvent({
            event: "game-over-event",
            payload: {
                gameId,
                session: 1,
                revision: 3,
                result,
                moves,
            },
        });
        await expect(notice).toHaveCount(1);
        await expect(
            page.getByRole("gridcell", { name: "e4, White Pawn", exact: true }),
        ).toHaveCount(1);
        const tab = await activeWorkspaceTab(page);
        await expect
            .poll(async () => {
                const stored = await page.evaluate(
                    (tabId) => sessionStorage.getItem(String(tabId)),
                    tab?.value,
                );
                return stored
                    ? deserializeStorageValue<{ state: { headers: { result: string } } }>(stored)
                          ?.state.headers.result
                    : null;
            })
            .toBe("*");
        if (delivery === "event") {
            await expect(page).toHaveScreenshot("game-interrupted.png", { fullPage: true });
        }
        await page.getByRole("button", { name: "Logs", exact: true }).click();
        await expect(page.getByText("Terminal diagnostics", { exact: true })).toBeVisible();
        await expect(page.getByText("Safe final engine diagnostic", { exact: true })).toBeVisible();
        if (delivery === "event") {
            await expect(page).toHaveScreenshot("game-terminal-logs.png", { fullPage: true });
        }
        await page.getByRole("button", { name: "Close engine logs", exact: true }).click();
        await page.getByRole("button", { name: "New Game", exact: true }).click();
        await expect(notice).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Start game", exact: true })).toBeVisible();
    });
}
