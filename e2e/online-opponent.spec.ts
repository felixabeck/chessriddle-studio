import type { Locator, Page } from "@playwright/test";
import {
    assertButtonGlyphsUnclipped,
    databaseCommands,
    expect,
    scrollbarFreeScreenshot,
    test,
    waitForFontsSettled,
    waitForTransitionsSettled,
    type MockScenario,
} from "./fixtures";
import { preparationCommands } from "./opponentPreparationFixtures";

const LINK_ID = "11111111-1111-4111-8111-111111111111";
const NONCE_UUID = "0a1b2c3d-4444-4444-8444-444444444444";
const NONCE = NONCE_UUID.slice(0, 8);
const OPPONENT_DB_ID = "opponent-online-db";
const OPPONENT_DB_FILENAME = `opponent-${LINK_ID}-${NONCE}.db3`;
const OPPONENT_DB_TITLE = "FirstWhite (online)";

const REVISION = "e2e-online-opponent-rev-1";

const lichessProfileCommand: NonNullable<MockScenario["commands"]> = {
    get_public_lichess_json: {
        result: JSON.stringify({
            id: "firstwhite",
            username: "FirstWhite",
            title: "IM",
            profile: { realName: "First White", flag: "DE" },
            count: { rated: 4321 },
        }),
    },
};

const opponentDbCommands = databaseCommands(OPPONENT_DB_ID, OPPONENT_DB_FILENAME, {
    title: OPPONENT_DB_TITLE,
    description: "",
    game_count: 19,
    player_count: 1,
    event_count: 1,
    storage_size: "8192",
    indexed: true,
});

const opponentDbMetadataCommands: NonNullable<MockScenario["commands"]> = {
    ...opponentDbCommands,
    get_players: {
        result: {
            data: [{ id: 1, name: "FirstWhite", elo: 2100, game_count: 19 }],
            count: 1,
        },
    },
};

async function bootLibrary(page: Page): Promise<Locator> {
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    await expect(page.getByText("Black vs e4")).toBeVisible();
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    window.__E2E_TAURI__
                        .invocations()
                        .filter(({ command }) => command === "list_workspace_databases").length,
            ),
        )
        .toBe(1);
    return page.getByRole("group", { name: "Add New" });
}

async function lookupAndConfirmOpponent(
    page: Page,
    addGroup: Locator,
    options?: {
        assertAccessible?: () => Promise<void>;
        beforeConfirm?: () => Promise<void>;
    },
): Promise<Locator> {
    await addGroup.getByRole("button", { name: "Online opponent", exact: true }).click();
    const lookupDialog = page.getByRole("dialog", { name: "Add online account", exact: true });
    await expect(lookupDialog).toBeVisible();
    await lookupDialog.getByRole("textbox", { name: "Username" }).fill("firstwhite");
    await lookupDialog.getByRole("button", { name: "Look up", exact: true }).click();
    await expect(lookupDialog.locator("[data-opponent-profile]")).toContainText("FirstWhite");
    await options?.assertAccessible?.();
    await options?.beforeConfirm?.();
    await lookupDialog.getByRole("button", { name: "Link account", exact: true }).click();
    return lookupDialog;
}

async function expectOpponentPreparationCard(page: Page): Promise<Locator> {
    await expect(page).toHaveURL(`/databases/${OPPONENT_DB_ID}`);

    const preview = page
        .getByRole("tabpanel", { name: "Players", exact: true })
        .locator('[data-database-pane="preview"]');
    await expect(preview.getByRole("tab", { name: "Preparation", exact: true })).toHaveAttribute(
        "aria-selected",
        "true",
    );

    const accounts = preview.locator("[data-opponent-accounts]");
    await expect(accounts).toContainText("FirstWhite");
    await expect(accounts.locator("[data-opponent-status]")).toHaveText("19 online games");

    await expect(preview.locator("[data-preparation-source]")).toHaveCount(0);
    await expect(preview.locator("[data-statistics-source]")).toHaveCount(0);
    await expect(preview.getByRole("radio", { name: /Over the board/ })).toHaveCount(0);
    await expect(preview.getByRole("radio", { name: /^Online/ })).toHaveCount(0);

    const prep = preview.locator("[data-player-preparation]");
    await expect(prep.locator("[data-preparation-lines]")).toContainText("Sicilian Najdorf");

    return preview;
}

test("online-opponent: imports an online-only opponent from the Library and opens their Preparation card", async ({
    page,
    mockScenario,
    assertAccessible,
    assertNoHorizontalOverflow,
}) => {
    await page.clock.setFixedTime(new Date("2026-11-08T12:00:00Z"));
    const emptyListing = { entries: [], unread: [] };

    await mockScenario({
        commands: {
            ...preparationCommands(REVISION),
            ...lichessProfileCommand,
            ...opponentDbMetadataCommands,
            prepare_download: { result: "online-opponent-ticket" },
            release_download: { result: null },
            // Before the import (mount, enterOnlineOpponent, listLinkDatabases) the file must not
            // exist yet, otherwise importLink treats it as a leftover and deletes it; after the
            // import it appears in the listing.
            list_workspace_databases: {
                outcomes: [
                    { result: emptyListing },
                    { result: emptyListing },
                    { result: emptyListing },
                ],
                result: opponentDbCommands.list_workspace_databases.result,
            },
            import_opponent_games: {
                // Stay running for both dialog screenshots; an 8s delay raced the 8s expect
                // timeout on CI and unmounted ImportProgress (dialog 53px shorter).
                hold: true,
                result: {
                    kind: "imported",
                    database: { id: { id: OPPONENT_DB_ID }, kind: "database" },
                    accounts: [
                        { account: { provider: "lichess", username: "FirstWhite" }, games: 19 },
                    ],
                    merged: true,
                },
            },
        },
    });

    const addGroup = await bootLibrary(page);
    const onlineOpponentButton = addGroup.getByRole("button", {
        name: "Online opponent",
        exact: true,
    });
    await expect(onlineOpponentButton).toBeVisible();
    await assertButtonGlyphsUnclipped(onlineOpponentButton);
    await assertNoHorizontalOverflow();
    await assertAccessible();
    await waitForFontsSettled(page);
    await waitForTransitionsSettled(page);
    await page.mouse.move(0, 0);
    await expect(addGroup).toHaveScreenshot("library-add-group.png", {
        stylePath: scrollbarFreeScreenshot,
    });

    const lookupDialog = await lookupAndConfirmOpponent(page, addGroup, {
        assertAccessible,
        // Override crypto.randomUUID for exactly the next two calls (link id and database nonce)
        // just before confirming the account.
        beforeConfirm: () =>
            page.evaluate(
                ([first, second]) => {
                    const original = crypto.randomUUID.bind(crypto);
                    const queue = [first, second];
                    crypto.randomUUID = (() => {
                        const next = queue.shift();
                        if (next !== undefined) {
                            if (queue.length === 0) crypto.randomUUID = original;
                            return next;
                        }
                        crypto.randomUUID = original;
                        return original();
                    }) as typeof crypto.randomUUID;
                },
                [LINK_ID, NONCE_UUID] as const,
            ),
    });
    await expect(lookupDialog).toBeHidden();

    const downloadModal = page.getByRole("dialog", {
        name: "Downloading FirstWhite",
        exact: true,
    });
    await expect(downloadModal).toBeVisible();
    await expect(downloadModal).toContainText(
        "Downloading online games. Closing this dialog keeps the download running.",
    );
    await expect(downloadModal.locator(".mantine-Progress-root")).toBeVisible();
    await expect(downloadModal.getByRole("progressbar")).toBeAttached();
    await expect(downloadModal.getByRole("status")).toHaveText("Loading games…");
    await expect(downloadModal.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
    await assertNoHorizontalOverflow();
    await assertAccessible();
    await waitForFontsSettled(page);
    await waitForTransitionsSettled(page);
    await expect(downloadModal).toHaveScreenshot("online-opponent-download.png", {
        animations: "disabled",
        stylePath: scrollbarFreeScreenshot,
    });

    // The native import reports the games written so far on its ticket; the dialog shows them.
    await page.evaluate(() =>
        window.__E2E_TAURI__.emit("progress-event", {
            id: "online-opponent-ticket",
            generation: "1",
            state: "running",
            progress: 0,
            finished: false,
            cleared: false,
            count: 1234,
        }),
    );
    await expect(downloadModal.getByRole("status")).toHaveText("1,234 games loaded");
    await expect(downloadModal.locator(".mantine-Progress-root")).toBeVisible();
    await assertNoHorizontalOverflow();
    await assertAccessible();
    await waitForTransitionsSettled(page);
    await expect(downloadModal).toHaveScreenshot("online-opponent-download-count.png", {
        animations: "disabled",
        stylePath: scrollbarFreeScreenshot,
    });

    expect(await page.evaluate(() => window.__E2E_TAURI__.release("import_opponent_games"))).toBe(
        true,
    );
    const preview = await expectOpponentPreparationCard(page);
    await expect(downloadModal).toHaveCount(0);

    const importInvocations = await page.evaluate(() =>
        window.__E2E_TAURI__
            .invocations()
            .filter(({ command }) => command === "import_opponent_games"),
    );
    expect(importInvocations).toHaveLength(1);
    expect(importInvocations[0].args).toMatchObject({
        request: {
            filename: OPPONENT_DB_FILENAME,
            title: OPPONENT_DB_TITLE,
            accounts: [{ provider: "lichess", username: "FirstWhite" }],
        },
    });

    await assertNoHorizontalOverflow();
    const importedNotice = page
        .locator(".mantine-Notification-root")
        .filter({ hasText: "Downloaded 19 online games." });
    if ((await importedNotice.count()) > 0) {
        await importedNotice.locator(".mantine-Notification-closeButton").click();
    }
    await expect(page.locator(".mantine-Notification-root")).toHaveCount(0);
    await assertAccessible();
    await waitForFontsSettled(page);
    await waitForTransitionsSettled(page);
    await page.mouse.move(0, 0);
    await expect(preview).toHaveScreenshot("online-opponent-preparation.png", {
        stylePath: scrollbarFreeScreenshot,
    });
    await expect(page.getByText(/Unexpected Tauri IPC command:/)).toHaveCount(0);
});

test("online-opponent: entering an already downloaded account opens its card without downloading again", async ({
    page,
    mockScenario,
    assertAccessible,
    assertNoHorizontalOverflow,
}) => {
    await page.clock.setFixedTime(new Date("2026-11-08T12:00:00Z"));
    await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [
        "opponent-links",
        JSON.stringify([
            {
                id: LINK_ID,
                playerName: "FirstWhite",
                accounts: [{ provider: "lichess", username: "FirstWhite" }],
                filter: {
                    years: 3,
                    timeControls: ["blitz", "rapid", "classical", "correspondence"],
                },
                database: OPPONENT_DB_FILENAME,
            },
        ]),
    ] as const);

    await mockScenario({
        commands: {
            ...preparationCommands(REVISION),
            ...lichessProfileCommand,
            ...opponentDbMetadataCommands,
        },
    });

    const addGroup = await bootLibrary(page);
    await lookupAndConfirmOpponent(page, addGroup, { assertAccessible });
    await expectOpponentPreparationCard(page);

    const importInvocations = await page.evaluate(() =>
        window.__E2E_TAURI__
            .invocations()
            .filter(({ command }) => command === "import_opponent_games"),
    );
    expect(importInvocations).toHaveLength(0);

    await assertNoHorizontalOverflow();
    await assertAccessible();
    await expect(page.getByText(/Unexpected Tauri IPC command:/)).toHaveCount(0);
});
