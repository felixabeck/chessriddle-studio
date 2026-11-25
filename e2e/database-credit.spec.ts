import { databaseCommands, expect, test } from "./fixtures";

const lumbraInfo = {
    title: "LumbrasGigaBase",
    description: "",
    player_count: 526_520,
    event_count: 120_000,
    game_count: 9_570_564,
    storage_size: "2789040128",
    indexed: true,
};

test("database-credit: the Lumbra card credits author, website, licence and release", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
}) => {
    await mockScenario({
        commands: {
            list_workspace_databases: { result: { entries: [], unread: [] } },
            verify_signed_bytes: { result: null },
            get_progress: { result: null },
        },
    });
    await page.goto("/library");
    await page.getByRole("button", { name: "Import or download database", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add Database", exact: true });
    const card = dialog
        .locator(".mantine-Paper-root")
        .filter({ hasText: "Lumbra's Gigabase" })
        .first();
    await expect(card.getByText("By Michael Jansen")).toBeVisible();
    await expect(card.getByRole("link", { name: "lumbrasgigabase.com" })).toHaveAttribute(
        "href",
        "https://lumbrasgigabase.com",
    );
    await expect(card.getByRole("link", { name: "CC BY-NC-SA 4.0" })).toHaveAttribute(
        "href",
        "https://creativecommons.org/licenses/by-nc-sa/4.0/",
    );
    await expect(
        card.getByText("June 2025 release, converted by the En Croissant project"),
    ).toBeVisible();
    await assertNoHorizontalOverflow();
    await expect(card).toHaveScreenshot("database-credit-card.png");
});

test("database-credit: an installed Lumbra copy keeps its credit in the Library", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
}) => {
    await mockScenario({
        commands: {
            ...databaseCommands("lumbra", "Lumbra's Gigabase.db3", lumbraInfo),
            verify_signed_bytes: { result: null },
        },
    });
    await page.goto("/library");
    await page.getByText("LumbrasGigaBase", { exact: true }).first().click();
    const credit = page.getByTestId("database-credit");
    await expect(credit.getByText("By Michael Jansen")).toBeVisible();
    await expect(credit.getByRole("link", { name: "CC BY-NC-SA 4.0" })).toBeVisible();
    await expect(page.getByText("Source", { exact: true })).toBeVisible();
    await assertNoHorizontalOverflow();
    await expect(credit).toHaveScreenshot("database-credit-installed.png");
});
