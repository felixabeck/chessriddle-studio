import { assertNothingClipped, expect, test } from "./fixtures";
import type { AccountStatus } from "../src/bindings/generated";
import { serializeStorageValue } from "../src/state/store/debouncedStorage";
import english from "../src/translation/en-US.json" with { type: "json" };
import german from "../src/translation/de-DE.json" with { type: "json" };

const connected: AccountStatus = {
    status: "connected",
    account: { handle: "native-account", username: "Alex", plan: "gold" },
    durability_uncertain: false,
};

for (const corner of [
    { locale: "en-US", width: 1440, scale: 100, scheme: "dark", copy: english.translation },
    { locale: "de-DE", width: 320, scale: 200, scheme: "light", copy: german.translation },
] as const) {
    test(`ChessRiddle account actions and independent warnings: ${corner.locale}`, async ({
        page,
        mockScenario,
        assertAccessible,
        assertNoHorizontalOverflow,
        capture,
    }, testInfo) => {
        const copy = corner.copy;
        await page.setViewportSize({ width: corner.width, height: 900 });
        await page.addInitScript(
            ({ locale, scale, scheme }) => {
                localStorage.setItem("i18nextLng", locale);
                localStorage.setItem("font-size", String(scale));
                localStorage.setItem("mantine-color-scheme", scheme);
            },
            { locale: corner.locale, scale: corner.scale, scheme: corner.scheme },
        );
        await mockScenario({
            commands: {
                chessriddle_account: {
                    results: [
                        { status: "disconnected" },
                        { ...connected, account: { ...connected.account, plan: "free" } },
                        { status: "disconnected" },
                    ],
                },
                connect_chessriddle: { result: connected, delay: 1000 },
                disconnect_chessriddle: {
                    result: {
                        status: "removed",
                        revocation_pending: true,
                        durability_uncertain: true,
                    },
                },
            },
        });
        await page.goto("/accounts");
        await expect(
            page.getByText(copy["Home.ChessRiddle.Disconnected"], { exact: true }),
        ).toBeVisible();
        await page
            .getByRole("button", { name: copy["Home.ChessRiddle.Connect"], exact: true })
            .click();
        await expect(page.getByText(copy["Home.ChessRiddle.Connecting"])).toBeVisible();
        await expect(
            page.getByRole("button", { name: copy["Home.ChessRiddle.Refresh"], exact: true }),
        ).toBeDisabled();
        expect(
            await page.evaluate(
                () =>
                    window.__E2E_TAURI__
                        .invocations()
                        .filter(({ command }) => command === "chessriddle_account").length,
            ),
        ).toBe(1);
        await expect(
            page.getByText(copy["Home.ChessRiddle.ConnectedAs"].replace("{{username}}", "Alex")),
        ).toBeVisible();
        await expect(
            page.getByText(copy["Home.ChessRiddle.PlanGold"], { exact: true }),
        ).toBeVisible();
        await page
            .getByRole("button", { name: copy["Home.ChessRiddle.Refresh"], exact: true })
            .click();
        await expect(
            page.getByText(copy["Home.ChessRiddle.PlanFree"], { exact: true }),
        ).toBeVisible();
        await page
            .getByRole("button", { name: copy["Home.ChessRiddle.Disconnect"], exact: true })
            .click();
        await expect(page.getByText(copy["Home.ChessRiddle.RevocationPending"])).toBeVisible();
        await expect(
            page.getByText(copy["Home.ChessRiddle.RemovalDurabilityUncertain"]),
        ).toBeVisible();
        await expect(
            page.getByRole("button", { name: copy["Home.ChessRiddle.Connect"], exact: true }),
        ).toBeEnabled();
        expect(
            await page.evaluate(
                () =>
                    window.__E2E_TAURI__
                        .invocations()
                        .filter(({ command }) => command === "disconnect_chessriddle").length,
            ),
        ).toBe(1);
        await assertNoHorizontalOverflow();
        await assertAccessible();
        const card = page.getByRole("region", {
            name: copy["Home.ChessRiddle.Title"],
            exact: true,
        });
        if (corner.width === 320) {
            const viewport = page.viewportSize()!;
            const box = (await card.boundingBox())!;
            const contentHeight = await card.evaluate((element) => element.scrollHeight);
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
            // A compressed card used to fit horizontally while clipping nearly all its content.
            expect(box.height).toBeGreaterThanOrEqual(Math.min(contentHeight, viewport.height));
            await assertNothingClipped(card, { mode: "reachable" });
            for (const action of await card.getByRole("button").all()) {
                await action.scrollIntoViewIfNeeded();
                const actionBox = (await action.boundingBox())!;
                expect(actionBox.y).toBeGreaterThanOrEqual(0);
                expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(viewport.height);
            }
            await testInfo.attach("card-geometry", {
                body: JSON.stringify({ viewport, box, contentHeight }, null, 2),
                contentType: "application/json",
            });
            await capture(`chessriddle-account-${corner.locale}-actions`);
            await card.evaluate((element) => element.scrollIntoView({ block: "start" }));
        }
        await capture(`chessriddle-account-${corner.locale}`);
    });
}

test("ChessRiddle unavailable preserves Lichess and Chess.com cards", async ({
    page,
    assertAccessible,
}) => {
    const sessions = serializeStorageValue([
        {
            player: "Lichess player",
            updatedAt: 0,
            lichess: {
                username: "lichess-player",
                account: { username: "lichess-player", perfs: {} },
            },
        },
        {
            player: "Chess.com player",
            updatedAt: 0,
            chessCom: { username: "chesscom-player", stats: {} },
        },
    ]);
    await page.addInitScript((sessions) => localStorage.setItem("sessions", sessions), sessions);
    await page.goto("/accounts");
    await expect(page.getByText("lichess-player", { exact: true })).toBeVisible();
    await expect(page.getByText("chesscom-player", { exact: true })).toBeVisible();
    await expect(
        page.getByRole("button", { name: english.translation["Home.Accounts.UpdateStats"] }),
    ).toHaveCount(2);
    await expect(page.getByText("ChessRiddle", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Connect", exact: true })).toHaveCount(0);
    await assertAccessible();
});

test("native connected status survives a page restart and website revocation requires reconnect", async ({
    page,
    mockScenario,
}) => {
    await mockScenario({ commands: { chessriddle_account: { result: connected } } });
    await page.goto("/accounts");
    await expect(page.getByText("Connected as Alex", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText("Connected as Alex", { exact: true })).toBeVisible();
    await page.evaluate(
        (connected) =>
            window.__E2E_TAURI__.configure({
                commands: {
                    chessriddle_account: { result: { status: "reconnectNeeded" } },
                    connect_chessriddle: { result: connected },
                },
            }),
        connected,
    );
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(
        page.getByText(english.translation["Home.ChessRiddle.ReconnectNeeded"]),
    ).toBeVisible();
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect(page.getByText("Connected as Alex", { exact: true })).toBeVisible();
});

test("failed local disconnect keeps the account and raw diagnostics stay hidden", async ({
    page,
    mockScenario,
}) => {
    await mockScenario({
        commands: {
            chessriddle_account: { result: connected },
            disconnect_chessriddle: { error: "storage" },
        },
    });
    await page.goto("/accounts");
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(page.getByText("Connected as Alex", { exact: true })).toBeVisible();
    await expect(
        page.getByText(english.translation["Home.ChessRiddle.Error.Storage"]),
    ).toBeVisible();
    await page.evaluate(() =>
        window.__E2E_TAURI__.configure({
            commands: {
                chessriddle_account: { error: "private server diagnostic" },
            },
        }),
    );
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(
        page.getByText(english.translation["Home.ChessRiddle.Error.Server"]),
    ).toBeVisible();
    await expect(page.getByText("private server diagnostic")).toHaveCount(0);
});

test("leaving Accounts during connect retires only the view", async ({ page, mockScenario }) => {
    await mockScenario({
        commands: {
            chessriddle_account: { results: [{ status: "disconnected" }, connected] },
            connect_chessriddle: { result: connected, delay: 500 },
        },
    });
    await page.goto("/accounts");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByText(english.translation["Home.ChessRiddle.Connecting"])).toBeVisible();
    await page.locator('a[href="/engines"]').click();
    await expect(page.getByRole("heading", { name: /engines/i })).toBeVisible();
    await page.locator('a[href="/accounts"]').click();
    await expect(page.getByText("Connected as Alex", { exact: true })).toBeVisible();
    expect(
        await page.evaluate(
            () =>
                window.__E2E_TAURI__
                    .invocations()
                    .filter(({ command }) => command === "connect_chessriddle").length,
        ),
    ).toBe(1);
});
