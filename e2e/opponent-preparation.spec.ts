import {
    activeWorkspaceTab,
    expect,
    gameOpeningFixture,
    gotoPreservingStorage,
    test,
    waitForFontsSettled,
} from "./fixtures";
import { preparationCommands } from "./opponentPreparationFixtures";

test("opponent-preparation: lists lines and gaps and opens a line at its position", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
}) => {
    await page.addInitScript(() => {
        localStorage.setItem("mantine-color-scheme", "light");
        localStorage.setItem("font-size", "100");
        localStorage.setItem("auto-save", "false");
    });
    await page.clock.setFixedTime(new Date("2026-11-08T12:00:00Z"));

    await mockScenario({ commands: preparationCommands() });

    // Establish the library workspace through the normal Library flow.
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    await expect(page.getByText("Black vs e4")).toBeVisible();

    // Open the database player card and switch to the Preparation tab.
    await gotoPreservingStorage(page, `/databases/${gameOpeningFixture.databaseId}`);
    await page.getByRole("tab", { name: "Players", exact: true }).click();
    const players = page.getByRole("tabpanel", { name: "Players", exact: true });
    await players
        .locator('[data-database-pane="table"] tbody tr')
        .filter({ hasText: "First White" })
        .click();
    const preview = players.locator('[data-database-pane="preview"]');
    await preview.getByRole("tab", { name: "Preparation", exact: true }).click();

    const prep = preview.locator("[data-player-preparation]");
    await expect(prep.locator("[data-preparation-summary]")).toContainText("26 games");
    await expect(prep.locator("[data-preparation-lines]")).toContainText("Sicilian Najdorf");
    await expect(prep.locator("[data-preparation-lines]")).toContainText("6 of 26 games");
    await expect(prep.locator("[data-preparation-gaps]")).toContainText("Bb5+");
    await expect(prep.locator("[data-preparation-gaps]")).toContainText("Nc3");

    await assertNoHorizontalOverflow();
    await waitForFontsSettled(page);
    await page.mouse.move(0, 0);
    await expect(preview).toHaveScreenshot("opponent-preparation-tab.png");

    // Raising the minimum drops the gap played in only 4 games, without a new search.
    const minGames = prep.getByRole("textbox", { name: "Minimum games", exact: true });
    await minGames.click();
    // The open list is as wide as its options, so the checked row (check icon + digit) is not
    // clipped by a list squeezed to the narrow trigger.
    const fit = await page.getByRole("option", { name: "1", exact: true }).evaluate((row) => {
        const icon = row.querySelector("svg")!.getBoundingClientRect();
        const label = row.querySelector("span")!.getBoundingClientRect();
        const box = row.getBoundingClientRect();
        const list = row.closest('[role="listbox"]')!.getBoundingClientRect();
        return { gap: label.left - icon.right, overflow: box.right - list.right };
    });
    expect(fit.gap).toBeGreaterThanOrEqual(0);
    expect(fit.overflow).toBeLessThanOrEqual(0.5);
    await page.getByRole("option", { name: "5", exact: true }).click();
    await expect(prep.locator("[data-preparation-gaps]")).not.toContainText("Nc3");
    await expect(prep.locator("[data-preparation-gaps]")).toContainText("Bb5+");
    await expect(prep.locator("[data-preparation-lines]")).toContainText("6 of 26 games");
    await minGames.click();
    await page.getByRole("option", { name: "1", exact: true }).click();
    await expect(prep.locator("[data-preparation-gaps]")).toContainText("Nc3");

    // Activating a line opens the repertoire chapter at the matched position (2...d6).
    await prep.locator("[data-preparation-line-row]").first().click();
    await expect(page).toHaveURL("/");
    expect((await activeWorkspaceTab(page))?.gameOrigin).toMatchObject({
        kind: "file",
        gameNumber: 0,
    });
    const notation = page.locator("#bottomRight");
    await expect(notation.getByRole("button", { name: "d6", exact: true })).toHaveAttribute(
        "aria-current",
        "true",
    );
    await expect(notation.locator("[data-notation-preparation-header]")).toContainText(
        "Preparing for First White",
    );
    await expect(notation.getByRole("button", { name: "c4", exact: true })).toHaveCount(0);
    await expect(notation.getByRole("button", { name: "b3", exact: true })).toHaveCount(0);
    await expect(notation.getByRole("button", { name: /Be2|♗e2/ })).toHaveCount(0);
    await expect(notation.locator('[data-notation-reveal-variations="2"]')).toContainText(
        "2 hidden lines",
    );
    await expect(notation.locator('[data-notation-reveal-variations="1"]')).toContainText(
        "1 hidden line",
    );
    await waitForFontsSettled(page);
    await page.mouse.move(0, 0);
    await expect(notation).toHaveScreenshot("opponent-preparation-opened-line.png");

    // Revealing by toggle opens only that parent's hidden side lines.
    await notation.locator('[data-notation-reveal-variations="2"]').click();
    await expect(notation.getByRole("button", { name: "c4", exact: true })).toBeVisible();
    await expect(notation.getByRole("button", { name: "b3", exact: true })).toBeVisible();
    await expect(notation.getByRole("button", { name: /Be2|♗e2/ })).toHaveCount(0);

    // Switching to "All lines" shows the remaining side lines; switching back restores the filter.
    await notation.getByText("All lines", { exact: true }).click();
    await expect(notation.getByRole("button", { name: /Be2|♗e2/ })).toBeVisible();
    await notation.getByText("Opponent's lines", { exact: true }).click();
    await expect(notation.getByRole("button", { name: /Be2|♗e2/ })).toHaveCount(0);

    // Table view also follows the filter.
    await page.getByRole("button", { name: "Table view", exact: true }).click();
    await expect(notation.getByRole("button", { name: /Be2|♗e2/ })).toHaveCount(0);
    await expect(notation.locator('[data-notation-reveal-variations="1"]')).toBeVisible();
    await notation.getByText("All lines", { exact: true }).click();
    await expect(notation.getByRole("button", { name: /Be2|♗e2/ })).toBeVisible();

    await expect(page.getByText(/Unexpected Tauri IPC command:/)).toHaveCount(0);
});

test("opponent-preparation: narrow card stacks Since and Minimum games controls and compacts list cells without overflow", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
}) => {
    await page.addInitScript(() => {
        localStorage.setItem("mantine-color-scheme", "light");
        localStorage.setItem("font-size", "100");
        localStorage.setItem("auto-save", "false");
    });
    await page.setViewportSize({ width: 320, height: 720 });
    await page.clock.setFixedTime(new Date("2026-11-08T12:00:00Z"));
    await mockScenario({ commands: preparationCommands() });

    await page.goto("/library");
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    await expect(page.getByText("Black vs e4")).toBeVisible();

    await gotoPreservingStorage(page, `/databases/${gameOpeningFixture.databaseId}`);
    await page.getByRole("tab", { name: "Players", exact: true }).click();
    const players = page.getByRole("tabpanel", { name: "Players", exact: true });
    await players
        .locator('[data-database-pane="table"] tbody tr')
        .filter({ hasText: "First White" })
        .click();
    const preview = players.locator('[data-database-pane="preview"]');
    await preview.getByRole("tab", { name: "Preparation", exact: true }).click();

    const prep = preview.locator("[data-player-preparation]");
    await expect(prep.locator("[data-preparation-lines]")).toContainText("Sicilian Najdorf");

    for (const name of ["Since", "Minimum games"]) {
        const layout = await prep.getByRole("textbox", { name, exact: true }).evaluate((select) => {
            const root = select.closest(".mantine-Select-root")!;
            const label = root.querySelector("label")!;
            const style = getComputedStyle(root);
            return {
                flexDirection: style.flexDirection,
                alignItems: style.alignItems,
                labelLeft: label.getBoundingClientRect().left,
                selectLeft: select.getBoundingClientRect().left,
            };
        });
        expect(layout.flexDirection, name).toBe("column");
        expect(layout.alignItems, name).toBe("start");
        expect(Math.abs(layout.labelLeft - layout.selectLeft), name).toBeLessThanOrEqual(1);
    }

    const cellStyle = await prep
        .locator("[data-preparation-lines] tbody td")
        .first()
        .evaluate((td) => {
            const style = getComputedStyle(td);
            return {
                paddingTop: style.paddingTop,
                paddingBottom: style.paddingBottom,
                borderBottomStyle: style.borderBottomStyle,
            };
        });
    expect(cellStyle).toEqual({
        paddingTop: "0px",
        paddingBottom: "0px",
        borderBottomStyle: "none",
    });

    await assertNoHorizontalOverflow();
});
