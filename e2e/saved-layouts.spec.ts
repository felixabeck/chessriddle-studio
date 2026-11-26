import type { Page } from "@playwright/test";
import {
    assertNothingClipped,
    chooseApplicationMenuItem,
    DEFAULT_BOARD_ARRANGEMENT,
    expect,
    filesWorkspaceCommands,
    filesWorkspaceFixture,
    gameOpeningFixture,
    goToSettings,
    gotoPreservingStorage,
    openApplicationMenu,
    pgnFileCommands,
    preserveStorageForReload,
    scrollbarFreeScreenshot,
    seedAnalysisEngines,
    selectFilesTreeRow,
    test,
    waitForBoardSizeSettled,
    waitForFontsSettled,
    waitForTransitionsSettled,
} from "./fixtures";
import { preparationCommands } from "./opponentPreparationFixtures";

const repertoireFile = {
    ...filesWorkspaceFixture.pgnFile,
    name: "Saved Layout Repertoire",
    metadata: { type: "repertoire" as const, tags: [] },
};

async function openFreshAnalysisBoard(page: Page, expectedMode: "mosaic" | "stacked" = "mosaic") {
    await page.goto("/");
    await page.getByRole("button", { name: /^Analysis Board$/ }).click();
    await expect(page.locator("[data-board-layout]")).toHaveAttribute(
        "data-board-layout",
        expectedMode,
    );
}

async function pullDatabaseBelowBoard(page: Page) {
    await page.locator('[data-arrange-grip="topRight"]').click();
    await page
        .getByRole("menuitem", { name: "Show Database as its own area", exact: true })
        .click();
    const placing = page.getByTestId("board-arrange-placing");
    await expect(placing).toBeVisible();
    await placing.getByRole("button", { name: "Below the board", exact: true }).click();
    await expect(placing).toHaveCount(0);
    await expect(page.locator('[data-panel-area="database"]')).toBeVisible();
}

test("saved-layouts: per-kind presets, kind isolation, save/replace, menus, shortcuts, rename, delete, and Reset", async ({
    page,
    mockScenario,
    assertAccessible,
    assertNoHorizontalOverflow,
}) => {
    // Runs every layout flow in one test (~53 s on CI vs. the default 45 s timeout).
    test.setTimeout(120_000);
    await seedAnalysisEngines(page, [
        { id: "layout-e2e-engine", name: "Layout Stockfish", handleId: "e2e-engine-handle" },
    ]);
    await mockScenario({
        commands: filesWorkspaceCommands([[repertoireFile]], {
            ...pgnFileCommands,
        }),
    });

    // 1. Fresh game tab opens with the Game review preset (two-pane default).
    await openFreshAnalysisBoard(page);
    await expect(page.locator('[data-panel-area="database"]')).toHaveCount(0);
    await expect(page.locator('[data-panel-area="annotate"]')).toHaveCount(0);
    await expect(page.locator('[data-engine-window="layout-e2e-engine"]')).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Database", exact: true })).toBeVisible();

    // Customize the game tab (pull Database below the board) and save it under "Study setup"
    // via the board More (⋯) menu.
    await pullDatabaseBelowBoard(page);

    await page.getByRole("button", { name: "More actions", exact: true }).click();
    const moreMenu = page.getByRole("menu", { name: "More actions", exact: true });
    await expect(moreMenu).toBeVisible();
    await expect(moreMenu.getByText("Layout", { exact: true })).toBeVisible();
    for (const label of [
        "Repertoire",
        "Game review",
        "Preparation",
        "Save layout as…",
        "Manage layouts…",
    ]) {
        const item = moreMenu.getByRole("menuitem", { name: label, exact: true });
        await expect(item).toBeVisible();
        await expect(item).not.toHaveAttribute("aria-checked");
    }
    await waitForFontsSettled(page);
    await waitForTransitionsSettled(page);
    await page.mouse.move(0, 0);
    await expect(moreMenu).toHaveScreenshot("saved-layouts-more-menu.png");
    await moreMenu.getByRole("menuitem", { name: "Save layout as…", exact: true }).click();

    const saveDialog = page.getByRole("dialog", { name: "Save layout as", exact: true });
    await expect(saveDialog).toBeVisible();
    const nameInput = saveDialog.getByRole("textbox", { name: "Layout name", exact: true });
    await expect(nameInput).toBeFocused();
    await assertAccessible();
    await waitForFontsSettled(page);
    await waitForTransitionsSettled(page);
    await page.mouse.move(0, 0);
    await expect(saveDialog).toHaveScreenshot("saved-layouts-save-dialog.png");
    await nameInput.fill("Study setup");
    await saveDialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(saveDialog).toHaveCount(0);

    // Reload and verify the saved layout persists alongside the live game layout.
    await preserveStorageForReload(page);
    await expect(page.locator('[data-panel-area="database"]')).toBeVisible();
    const storedAfterSave = await page.evaluate(() =>
        JSON.parse(localStorage.getItem("analysis-board-layouts")!),
    );
    expect(storedAfterSave.version).toBe(1);
    expect(storedAfterSave.saved).toHaveLength(1);
    expect(storedAfterSave.saved[0].name).toBe("Study setup");
    const savedId = storedAfterSave.saved[0].id as string;

    // 2. Open a repertoire tab and verify it gets the Repertoire preset (Database, Annotate,
    // and resolved placeholder engine window) without disturbing the customized game tab.
    await page.getByRole("link", { name: "Library", exact: true }).click();
    await expect(page).toHaveURL("/library");
    // Off the boards route, the Application menu does not include board layout entries.
    await openApplicationMenu(page);
    const appMenu = page.getByRole("menu", { name: "Application menu", exact: true });
    await expect(appMenu).toBeVisible();
    await expect(appMenu.getByRole("menuitem", { name: "Settings", exact: true })).toBeVisible();
    await expect(
        appMenu.getByRole("menuitem", { name: "Save layout as…", exact: true }),
    ).toHaveCount(0);
    await expect(appMenu.getByRole("menuitem", { name: "Layouts…", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(appMenu).toHaveCount(0);

    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    await selectFilesTreeRow(page, repertoireFile.name);
    await page.getByRole("button", { name: "Open game", exact: true }).click();
    await expect(page).toHaveURL("/");

    await expect(page.locator('[data-panel-area="database"]')).toBeVisible();
    await expect(page.locator('[data-panel-area="annotate"]')).toBeVisible();
    await expect(page.locator('[data-engine-window="layout-e2e-engine"]')).toBeVisible();
    await assertNoHorizontalOverflow();
    await waitForBoardSizeSettled(page);
    await waitForFontsSettled(page);
    await waitForTransitionsSettled(page);
    await page.mouse.move(0, 0);
    await expect(page.locator("[data-board-layout]")).toHaveScreenshot(
        "saved-layouts-repertoire-preset.png",
        { stylePath: scrollbarFreeScreenshot },
    );

    // 3. Switch back to the game tab and see its own customized layout preserved.
    const workspaceTabs = page.locator("header [role='tablist'] [role='tab']");
    await workspaceTabs.first().click();
    await expect(page.locator('[data-panel-area="database"]')).toBeVisible();
    await expect(page.locator('[data-panel-area="annotate"]')).toHaveCount(0);
    await expect(page.locator('[data-engine-window="layout-e2e-engine"]')).toHaveCount(0);

    // 4. Apply a preset through the ⋯ menu (Game review), then verify "Study setup" is
    // unchanged and apply it back through View → Layouts….
    await page.getByRole("button", { name: "More actions", exact: true }).click();
    const gameMenu = page.getByRole("menu", { name: "More actions", exact: true });
    await expect(
        gameMenu.getByRole("menuitem", { name: "Study setup", exact: true }),
    ).toBeVisible();
    await gameMenu.getByRole("menuitem", { name: "Game review", exact: true }).click();
    await expect(page.locator('[data-panel-area="database"]')).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Database", exact: true })).toBeVisible();

    await chooseApplicationMenuItem(page, "Layouts…");
    const manageDialog = page.getByRole("dialog", { name: "Board layouts", exact: true });
    await expect(manageDialog).toBeVisible();
    await assertAccessible();
    await waitForFontsSettled(page);
    await waitForTransitionsSettled(page);
    await page.mouse.move(0, 0);
    await expect(manageDialog).toHaveScreenshot("saved-layouts-manage-dialog.png");

    // Presets are read-only (Apply only, no Rename/Delete).
    const repertoireRow = manageDialog.locator('[data-layout-id="preset:repertoire"]');
    await expect(repertoireRow).toContainText("Repertoire");
    await expect(repertoireRow).toContainText("Preset");
    await expect(repertoireRow.getByRole("button")).toHaveText(["Apply"]);

    // Saved layout row has Apply, Rename, and Delete; clicking Apply restores it to the game kind.
    const savedRow = manageDialog.locator(`[data-layout-id="${savedId}"]`);
    await expect(savedRow).toContainText("Study setup");
    await savedRow.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(manageDialog).toHaveCount(0);
    await expect(page.locator('[data-panel-area="database"]')).toBeVisible();

    // Editing the live layout after applying does not mutate the saved copy.
    await page
        .locator('[data-panel-area="database"]')
        .getByRole("button", { name: "Return to the tabs", exact: true })
        .click();
    await expect(page.locator('[data-panel-area="database"]')).toHaveCount(0);
    const storedAfterLiveEdit = await page.evaluate(() =>
        JSON.parse(localStorage.getItem("analysis-board-layouts")!),
    );
    expect(storedAfterLiveEdit.saved[0].arrangement.first.second).toBe("database");

    // 5. Save with a case-insensitive duplicate name via View → Save layout as… prompts to replace.
    await page.getByRole("button", { name: "Hide the tabs" }).click();
    await expect(page.locator("[data-board-tab-list]")).toBeHidden();
    await chooseApplicationMenuItem(page, "Save layout as…");
    await expect(saveDialog).toBeVisible();
    await saveDialog.getByRole("textbox", { name: "Layout name", exact: true }).fill("study setup");
    await saveDialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
        saveDialog.getByText('A saved layout named "Study setup" already exists. Replace it?'),
    ).toBeVisible();
    await saveDialog.getByRole("button", { name: "Replace", exact: true }).click();
    await expect(saveDialog).toHaveCount(0);

    const storedAfterReplace = await page.evaluate(() =>
        JSON.parse(localStorage.getItem("analysis-board-layouts")!),
    );
    expect(storedAfterReplace.saved).toHaveLength(1);
    expect(storedAfterReplace.saved[0].id).toBe(savedId);
    expect(storedAfterReplace.saved[0].tabsHidden).toBe(true);

    // 6. Shortcut Control+Alt+1 applies list entry 1 (Repertoire preset) to the active game tab,
    // and Control+Alt+2 applies list entry 2 (Game review preset).
    await page.locator("#bottomRight").click();
    await page.keyboard.press("Control+Alt+1");
    await expect(page.locator('[data-panel-area="database"]')).toBeVisible();
    await expect(page.locator('[data-panel-area="annotate"]')).toBeVisible();
    await expect(page.locator('[data-engine-window="layout-e2e-engine"]')).toBeVisible();
    await expect(page.locator("[data-board-tab-list]")).toBeVisible();

    await page.keyboard.press("Control+Alt+2");
    await expect(page.locator('[data-panel-area="database"]')).toHaveCount(0);
    await expect(page.locator('[data-panel-area="annotate"]')).toHaveCount(0);
    await expect(page.locator('[data-engine-window="layout-e2e-engine"]')).toHaveCount(0);

    // 7. Rename and delete the saved layout in View → Layouts…, then test Reset keeps saved layouts.
    await chooseApplicationMenuItem(page, "Layouts…");
    await expect(manageDialog).toBeVisible();
    await savedRow.getByRole("button", { name: "Rename", exact: true }).click();
    const renameInput = manageDialog.getByRole("textbox", { name: "Layout name", exact: true });
    await renameInput.fill("Tournament prep");
    await manageDialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(savedRow).toContainText("Tournament prep");

    await preserveStorageForReload(page);
    await chooseApplicationMenuItem(page, "Layouts…");
    await expect(manageDialog.locator(`[data-layout-id="${savedId}"]`)).toContainText(
        "Tournament prep",
    );
    await manageDialog.getByRole("button", { name: "Close dialog", exact: true }).last().click();
    await expect(manageDialog).toHaveCount(0);

    // Customize game layout again, then run Settings → Reset layout and verify presets are
    // restored for all three kinds while "Tournament prep" remains in saved layouts.
    await pullDatabaseBelowBoard(page);
    await goToSettings(page);
    await page.getByRole("tab", { name: "Analysis & notation", exact: true }).click();
    await expect(
        page.getByText(
            "Restore the preset layouts for repertoire, game and preparation tabs; saved layouts are kept",
            { exact: true },
        ),
    ).toBeVisible();
    await page.getByRole("button", { name: "Reset layout", exact: true }).click();

    const afterReset = await page.evaluate(() =>
        JSON.parse(localStorage.getItem("analysis-board-layouts")!),
    );
    expect(afterReset.saved).toHaveLength(1);
    expect(afterReset.saved[0].name).toBe("Tournament prep");
    expect(afterReset.kinds.game).toEqual({
        arrangement: DEFAULT_BOARD_ARRANGEMENT,
        tabsHidden: false,
    });
    expect(afterReset.kinds.repertoire.arrangement.first.second).toBe("engine:@1");
    expect(afterReset.kinds.preparation.arrangement.second.first).toBe("database");

    // Return to the game tab (shows restored Game review preset) and delete the saved layout.
    await workspaceTabs.first().click();
    await expect(page).toHaveURL("/");
    await expect(page.locator('[data-panel-area="database"]')).toHaveCount(0);

    await chooseApplicationMenuItem(page, "Layouts…");
    await expect(manageDialog).toBeVisible();
    await manageDialog
        .locator(`[data-layout-id="${savedId}"]`)
        .getByRole("button", { name: "Delete", exact: true })
        .click();
    await expect(
        manageDialog.getByText('Delete layout "Tournament prep"?', { exact: true }),
    ).toBeVisible();
    await manageDialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(manageDialog.locator(`[data-layout-id="${savedId}"]`)).toHaveCount(0);
    await manageDialog.getByRole("button", { name: "Close dialog", exact: true }).last().click();

    await preserveStorageForReload(page);
    const afterDelete = await page.evaluate(() =>
        JSON.parse(localStorage.getItem("analysis-board-layouts")!),
    );
    expect(afterDelete.saved).toEqual([]);
});

test("saved-layouts: fresh opponent-preparation tab opens with the Preparation preset without disturbing game or repertoire", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
}) => {
    await mockScenario({ commands: preparationCommands() });
    await page.clock.setFixedTime(new Date("2026-11-08T12:00:00Z"));

    // Customize the game kind first so we can verify preparation leaves game and repertoire intact.
    await openFreshAnalysisBoard(page);
    await pullDatabaseBelowBoard(page);
    const beforeLayouts = await page.evaluate(() =>
        JSON.parse(localStorage.getItem("analysis-board-layouts")!),
    );

    await page.getByRole("link", { name: "Library", exact: true }).click();
    await expect(page).toHaveURL("/library");
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
    await preview.locator("[data-preparation-line-row]").first().click();
    await expect(page).toHaveURL("/");

    // Preparation preset shows Database on top right, Notation + tabs side-by-side below, no engine window.
    const dbArea = page.locator('[data-panel-area="database"]');
    const notationArea = page.locator("#bottomRight");
    const tabsArea = page.locator("#topRight");
    await expect(dbArea).toBeVisible();
    await expect(notationArea).toBeVisible();
    await expect(tabsArea).toBeVisible();
    await expect(page.locator("[data-engine-window]")).toHaveCount(0);

    const dbBox = (await dbArea.boundingBox())!;
    const notationBox = (await notationArea.boundingBox())!;
    const tabsBox = (await tabsArea.boundingBox())!;
    expect(dbBox.y + dbBox.height).toBeLessThanOrEqual(notationBox.y + 8);
    expect(notationBox.x + notationBox.width).toBeLessThanOrEqual(tabsBox.x + 8);

    await assertNoHorizontalOverflow();

    const afterPrepLayouts = await page.evaluate(() =>
        JSON.parse(localStorage.getItem("analysis-board-layouts")!),
    );
    expect(afterPrepLayouts.kinds.game).toEqual(beforeLayouts.kinds.game);
    expect(afterPrepLayouts.kinds.repertoire).toEqual(beforeLayouts.kinds.repertoire);

    // Switching back to the game tab shows its customized below-board Database layout.
    await page.locator("header [role='tablist'] [role='tab']").first().click();
    await expect(page.locator("[data-board-layout]")).toHaveAttribute(
        "data-board-layout",
        "mosaic",
    );
    await expect(dbArea).toBeVisible();
    await expect(page.locator("#left cg-board")).toBeVisible();
    await waitForBoardSizeSettled(page);
    const gameBoardBox = (await page.locator("#left").boundingBox())!;
    const gameDbBox = (await dbArea.boundingBox())!;
    expect(gameDbBox.y).toBeGreaterThanOrEqual(gameBoardBox.y + gameBoardBox.height - 8);
});

test("saved-layouts: narrow save and manage layout dialogs fit without overflow", async ({
    page,
    assertNoHorizontalOverflow,
}) => {
    await openFreshAnalysisBoard(page, "stacked");

    await chooseApplicationMenuItem(page, "Save layout as…");
    const saveDialog = page.getByRole("dialog", { name: "Save layout as", exact: true });
    await expect(saveDialog).toBeVisible();
    await assertNoHorizontalOverflow();
    await assertNothingClipped(saveDialog, { mode: "reachable" });
    await waitForFontsSettled(page);
    await waitForTransitionsSettled(page);
    await page.mouse.move(0, 0);
    await expect(saveDialog).toHaveScreenshot("saved-layouts-save-dialog.png");

    const longLayoutName = "RepertoireNajdorfEnglishAttackLinesWhite";
    await saveDialog
        .getByRole("textbox", { name: "Layout name", exact: true })
        .fill(longLayoutName);
    await saveDialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(saveDialog).toHaveCount(0);

    await chooseApplicationMenuItem(page, "Layouts…");
    const manageDialog = page.getByRole("dialog", { name: "Board layouts", exact: true });
    await expect(manageDialog).toBeVisible();
    const savedName = manageDialog.getByText(longLayoutName, { exact: true });
    await expect(savedName).toBeVisible();
    expect(await savedName.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
    );
    await assertNoHorizontalOverflow();
    await assertNothingClipped(manageDialog, { mode: "reachable" });
    await waitForFontsSettled(page);
    await waitForTransitionsSettled(page);
    await page.mouse.move(0, 0);
    await expect(manageDialog).toHaveScreenshot("saved-layouts-manage-dialog.png");

    // Delete confirmation prompt wraps the 40-char spaceless name without horizontal overflow.
    await manageDialog.getByRole("button", { name: "Delete", exact: true }).click();
    const deletePrompt = manageDialog.getByText(`Delete layout "${longLayoutName}"?`, {
        exact: true,
    });
    await expect(deletePrompt).toBeVisible();
    expect(
        await deletePrompt.evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await assertNoHorizontalOverflow();
    await assertNothingClipped(manageDialog, { mode: "reachable" });
    await manageDialog.getByRole("button", { name: "Cancel", exact: true }).click();

    // Replace confirmation prompt wraps the same 40-char spaceless name without horizontal overflow.
    await manageDialog.getByRole("button", { name: "Save layout as…", exact: true }).click();
    await expect(saveDialog).toBeVisible();
    await saveDialog
        .getByRole("textbox", { name: "Layout name", exact: true })
        .fill(longLayoutName);
    await saveDialog.getByRole("button", { name: "Save", exact: true }).click();
    const replacePrompt = saveDialog.getByText(
        `A saved layout named "${longLayoutName}" already exists. Replace it?`,
        { exact: true },
    );
    await expect(replacePrompt).toBeVisible();
    expect(
        await replacePrompt.evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await assertNoHorizontalOverflow();
    await assertNothingClipped(saveDialog, { mode: "reachable" });
});
