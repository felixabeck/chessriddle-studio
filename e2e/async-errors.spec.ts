import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import type { ErrorPayload } from "../src/bindings/generated";
import germanCatalogue from "../src/translation/de-DE.json" with { type: "json" };
import englishCatalogue from "../src/translation/en-US.json" with { type: "json" };
import {
    databaseCommands,
    expect,
    expectNotificationSettled,
    filesWorkspaceCommands,
    filesWorkspaceFixture,
    pgnFileCommands,
    assertFilesColumnsNotClipped,
    assertNothingClipped,
    assertPageNotClipped,
    selectFilesTreeRow,
    test,
    waitForTransitionsSettled,
    type MockScenario,
} from "./fixtures";

const { workspace, openingDirectory, pgnFile } = filesWorkspaceFixture;
const germanListingCopy = germanCatalogue.translation;

for (const scenario of [
    {
        locale: "de-DE",
        status: 401,
        authorizationSent: true,
        service: "lichess",
        key: "Common.RemoteRequest.AuthorizationRejected",
    },
    {
        locale: "de-DE",
        status: 429,
        authorizationSent: false,
        service: "chesscom",
        key: "Common.RemoteRequest.RateLimited",
    },
    {
        locale: "en-US",
        status: 500,
        authorizationSent: false,
        service: "chesscom",
        key: "Common.RemoteRequest.ServerFailed",
    },
] as const) {
    test(`remote HTTP download: ${scenario.locale} status ${scenario.status}`, async ({
        page,
        mockScenario,
        assertNoHorizontalOverflow,
    }) => {
        const { locale, status, authorizationSent, service, key } = scenario;
        const copy =
            locale === "de-DE" ? germanCatalogue.translation : englishCatalogue.translation;
        if (locale === "de-DE") await page.setViewportSize({ width: 320, height: 900 });
        await page.addInitScript(
            ({ locale, service }) => {
                localStorage.setItem("i18nextLng", locale);
                localStorage.setItem("font-size", locale === "de-DE" ? "200" : "100");
                localStorage.setItem(
                    "sessions",
                    JSON.stringify([
                        {
                            player: "download-player",
                            updatedAt: Date.UTC(2026, 9, 4),
                            ...(service === "lichess"
                                ? {
                                      lichess: {
                                          username: "download-player",
                                          handle: "download-account",
                                          account: {
                                              id: "download-player",
                                              username: "download-player",
                                              perfs: {},
                                          },
                                      },
                                  }
                                : {
                                      chessCom: {
                                          username: "download-player",
                                          stats: {
                                              chess_rapid: {
                                                  last: { rating: 1500, date: 1791072000, rd: 50 },
                                                  record: { win: 1, loss: 0, draw: 0 },
                                              },
                                          },
                                      },
                                  }),
                        },
                    ]),
                );
            },
            { locale, service },
        );
        const error: ErrorPayload = {
            tag: "backend-error",
            category: status === 401 ? "authentication" : "network",
            message: `Remote HTTP request rejected: status ${status}`,
            remoteHttpRejection: { status, authorizationSent },
        };
        await mockScenario({
            commands: {
                list_lichess_accounts: {
                    result:
                        service === "lichess"
                            ? [{ handle: "download-account", username: "download-player" }]
                            : [],
                },
                issue_download_destination: { result: { id: "download-destination" } },
                create_workspace_database: {
                    result: { id: { id: "download-database" }, kind: "database" },
                },
                import_account_games: { delay: 120, error },
            },
        });
        await page.goto("/accounts");
        const download = page.getByRole("button", {
            name: copy["Home.Accounts.DownloadGames"],
            exact: true,
        });
        await expect(download).toBeEnabled();
        await download.click();
        await page.mouse.move(0, 0);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("tooltip")).toHaveCount(0);
        const notification = page.locator(".mantine-Notification-root");
        await expect(notification).toHaveCount(1);
        await expect(notification).toContainText(copy[key]);
        const guidance = notification.locator(".mantine-Notification-description");
        await expect(guidance).toHaveText(copy[key]);
        await expectNotificationSettled(notification);
        await expect(download).toBeEnabled();
        const invocations = await page.evaluate(() => window.__E2E_TAURI__.invocations());
        expect(
            invocations.filter(({ command: invoked }) => invoked === "import_account_games"),
        ).toHaveLength(1);
        expect(
            invocations.filter(({ command: invoked }) =>
                ["download_lichess_games", "download_chess_com_games", "convert_pgn"].includes(
                    invoked,
                ),
            ),
        ).toEqual([]);
        await assertNoHorizontalOverflow();
        await assertNothingClipped(notification, { mode: "reachable" });
        await expect(guidance).toBeInViewport({ ratio: 1 });
        await expect(notification).toBeInViewport({ ratio: 1 });
        await expect(notification).toHaveScreenshot(`remote-http-${locale}-${status}.png`, {
            stylePath: fileURLToPath(new URL("./notification-screenshot.css", import.meta.url)),
        });
    });
}

for (const locale of ["en-US", "de-DE"] as const) {
    for (const relistFails of [false, true]) {
        test(`workspace cleanup: ${locale}, relist fails=${relistFails}, 320px and 200%`, async ({
            page,
            mockScenario,
            assertNoHorizontalOverflow,
            capture,
        }) => {
            const copy =
                locale === "de-DE" ? germanCatalogue.translation : englishCatalogue.translation;
            const leftover = { ...openingDirectory, name: "Leftover" };
            await page.setViewportSize({ width: 320, height: 900 });
            await page.addInitScript((language) => {
                localStorage.setItem("font-size", "200");
                localStorage.setItem("i18nextLng", language);
            }, locale);
            await mockScenario({
                commands: filesWorkspaceCommands([], {
                    create_workspace_directory: {
                        error: {
                            tag: "backend-error",
                            category: "operation-and-cleanup",
                            message: "private cleanup diagnostic",
                        },
                    },
                    list_file_workspace: {
                        outcomes: [
                            { result: { entries: [], unread: [] } },
                            relistFails
                                ? {
                                      error: {
                                          tag: "backend-error",
                                          category: "io",
                                          message: "private relist diagnostic",
                                      },
                                  }
                                : { result: { entries: [leftover], unread: [] } },
                        ],
                    },
                }),
            });
            await page.goto("/library");
            await page
                .getByRole("button", { name: copy["Files.ChooseCollection"], exact: true })
                .click();
            await expect
                .poll(() =>
                    page.evaluate(
                        () =>
                            window.__E2E_TAURI__
                                .invocations()
                                .filter(({ command }) => command === "list_file_workspace").length,
                    ),
                )
                .toBe(1);
            await page
                .getByRole("button", { name: copy["Files.CreateFolder"], exact: true })
                .click();
            const dialog = page.getByRole("dialog", {
                name: copy["Files.CreateFolder"],
                exact: true,
            });
            const name = dialog.getByRole("textbox", { name: copy["Common.Name"], exact: true });
            await name.fill("Leftover");
            await dialog.getByRole("button", { name: copy["Common.Confirm"], exact: true }).click();
            await expect(dialog).toContainText(copy["Files.OperationAndCleanupFailed"]);
            await expect(dialog).not.toContainText(copy["Files.OperationFailed"]);
            await expect(name).toHaveValue("Leftover");
            await expect(
                page.getByRole("treeitem", { name: "Leftover", exact: true, includeHidden: true }),
            ).toHaveCount(relistFails ? 0 : 1);
            const commands = await page.evaluate(() =>
                window.__E2E_TAURI__.invocations().map(({ command }) => command),
            );
            expect(
                commands.filter((command) => command === "create_workspace_directory"),
            ).toHaveLength(1);
            expect(commands.filter((command) => command === "list_file_workspace")).toHaveLength(2);
            await expect(page.locator("body")).not.toContainText("private cleanup diagnostic");
            await expect(page.locator("body")).not.toContainText("private relist diagnostic");
            await dialog
                .getByRole("button", { name: copy["Common.Confirm"], exact: true })
                .scrollIntoViewIfNeeded();
            await assertDialogWithinViewport(dialog);
            await assertNothingClipped(dialog, { mode: "reachable" });
            await assertNoHorizontalOverflow();
            // BASE (unlayered Mantine, measured 2026-11-07): .m_54c44539[data-full-screen]
            // sets border-radius: 0 and beat Paper/Modal theme radius by specificity.
            await expect(dialog).toHaveCSS("border-radius", "0px");
            if (!relistFails)
                await expect(dialog).toHaveScreenshot(`workspace-cleanup-320-200-${locale}.png`);
            await capture(
                `workspace-cleanup-${locale}-${relistFails ? "relist-failed" : "reconciled"}`,
            );
        });
    }
}

for (const locale of ["en-US", "de-DE"] as const) {
    for (const action of ["file", "folder", "rename", "metadata", "move"] as const) {
        const reconciles = action === "folder" || action === "rename" || action === "move";
        for (const relistFails of reconciles ? [false, true] : [false]) {
            test(`Files refusal ${action}: ${locale}, relist fails=${relistFails}, 320px and 200%`, async ({
                page,
                mockScenario,
                assertNoHorizontalOverflow,
                capture,
            }) => {
                const copy =
                    locale === "de-DE" ? germanCatalogue.translation : englishCatalogue.translation;
                const destination = { ...openingDirectory, name: "Target" };
                const current = {
                    ...openingDirectory,
                    handle: { id: { id: "current-directory" }, kind: "fileWorkspace" },
                    name: "Current",
                };
                const command = {
                    file: "create_workspace_file",
                    folder: "create_workspace_directory",
                    rename: "rename_workspace_file",
                    metadata: "write_workspace_file_metadata",
                    move: "move_workspace_entry",
                }[action];
                const category =
                    action === "file"
                        ? "invalid-input"
                        : action === "metadata"
                          ? "resource-limit"
                          : action === "rename"
                            ? "missing-resource"
                            : "conflict";
                const key =
                    action === "file"
                        ? "Files.Refusal.Invalid"
                        : action === "metadata"
                          ? "Files.Refusal.Limit"
                          : action === "rename"
                            ? "Files.Refusal.Unavailable"
                            : "Files.Refusal.Changed";
                await page.setViewportSize({ width: 320, height: 900 });
                await page.addInitScript((language) => {
                    localStorage.setItem("font-size", "200");
                    localStorage.setItem("i18nextLng", language);
                }, locale);
                await mockScenario({
                    commands: filesWorkspaceCommands([], {
                        ...pgnFileCommands,
                        [command]: {
                            error: {
                                tag: "backend-error",
                                category,
                                message: "private mutation diagnostic",
                            },
                        },
                        list_file_workspace: {
                            outcomes: [
                                { result: { entries: [pgnFile, destination], unread: [] } },
                                relistFails
                                    ? {
                                          error: {
                                              tag: "backend-error",
                                              category: "permission",
                                              message: "private listing diagnostic",
                                          },
                                      }
                                    : { result: { entries: [current], unread: [] } },
                            ],
                        },
                    }),
                });
                await page.goto("/library");
                await page
                    .getByRole("button", { name: copy["Files.ChooseCollection"], exact: true })
                    .click();
                await expect(
                    page.getByRole("treeitem", { name: destination.name, exact: true }),
                ).toBeVisible();
                if (action === "folder") await selectFilesTreeRow(page, destination.name);
                else if (action !== "file") await selectFilesTreeRow(page, pgnFile.name);
                const trigger =
                    action === "file"
                        ? "Files.CreateFile"
                        : action === "folder"
                          ? "Files.CreateFolder"
                          : action === "rename"
                            ? "Files.Rename"
                            : action === "metadata"
                              ? "Files.EditMetadata"
                              : "Files.Move";
                if (action === "move")
                    await page
                        .getByRole("treeitem", { name: pgnFile.name, exact: true })
                        .getByRole("button", { name: copy[trigger], exact: true })
                        .click();
                else await page.getByRole("button", { name: copy[trigger], exact: true }).click();
                const dialog = page.getByRole("dialog");
                const input = dialog.getByRole("textbox", {
                    name: copy["Common.Name"],
                    exact: true,
                });
                if (action === "metadata") {
                    await dialog
                        .getByRole("textbox", { name: copy["Files.FileType"], exact: true })
                        .click();
                    await page
                        .getByRole("option", {
                            name: copy["Files.FileType.Repertoire"],
                            exact: true,
                        })
                        .click();
                } else if (action === "move") {
                    await dialog
                        .getByRole("radio", { name: destination.name, exact: true })
                        .click();
                } else await input.fill("Retained draft");
                const submit = dialog.getByRole("button", {
                    name: copy[action === "move" ? "Files.Move" : "Common.Confirm"],
                    exact: true,
                });
                await submit.click();
                await expect(dialog).toContainText(copy[key]);
                await expect(dialog).not.toContainText(copy["Files.OperationFailed"]);
                if (action !== "move")
                    await expect(input).toHaveValue(
                        action === "metadata" ? pgnFile.name : "Retained draft",
                    );
                if (action === "metadata")
                    await expect(
                        dialog.getByRole("textbox", { name: copy["Files.FileType"], exact: true }),
                    ).toHaveValue(copy["Files.FileType.Repertoire"]);
                if (action === "move")
                    await expect(
                        dialog.getByRole("radio", { name: destination.name, exact: true }),
                    ).toBeChecked();
                if (reconciles) {
                    await expect(
                        page.getByRole("treeitem", {
                            name: current.name,
                            exact: true,
                            includeHidden: true,
                        }),
                    ).toHaveCount(relistFails ? 0 : 1);
                    await submit.click();
                    await expect(dialog).toContainText(copy[key]);
                }
                const invocations = await page.evaluate(() => window.__E2E_TAURI__.invocations());
                expect(invocations.filter((call) => call.command === command)).toHaveLength(1);
                expect(
                    invocations.filter((call) => call.command === "list_file_workspace"),
                ).toHaveLength(reconciles ? 2 : 1);
                if (action === "folder")
                    expect(
                        invocations.find((call) => call.command === command)?.args.parent,
                    ).toEqual(destination.handle);
                if (action === "move")
                    expect(
                        invocations.find((call) => call.command === command)?.args.targetDirectory,
                    ).toEqual(destination.handle);
                await expect(page.locator("body")).not.toContainText("private mutation diagnostic");
                await expect(page.locator("body")).not.toContainText("private listing diagnostic");
                await submit.scrollIntoViewIfNeeded();
                await expect(submit).toBeEnabled();
                await assertNothingClipped(submit, { mode: "reachable" });
                await dialog
                    .getByRole("button", { name: copy["Common.Close"], exact: true })
                    .scrollIntoViewIfNeeded();
                await assertDialogWithinViewport(dialog);
                await assertNothingClipped(dialog, { mode: "reachable" });
                await assertNoHorizontalOverflow();
                const screenshot = `workspace-refusal-${action}-${relistFails ? "relist-failed" : "retained"}-320-200-${locale}`;
                await expect(dialog).toHaveScreenshot(`${screenshot}.png`);
                await capture(screenshot);
            });
        }
    }
}

async function assertNativeTextValueReachable(input: Locator, expectedValue: string) {
    await input.focus();
    await input.press("End");
    await expect.poll(() => input.evaluate((input) => input.scrollLeft)).toBeGreaterThan(0);
    await input.press("Home");
    await expect.poll(() => input.evaluate((input) => input.scrollLeft)).toBe(0);
    await expect(input).toHaveValue(expectedValue);
}

test("engine editor: current configuration error at 320px and 200% German", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
    capture,
}) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.addInitScript(() => {
        localStorage.setItem("font-size", "200");
        localStorage.setItem("i18nextLng", "de-DE");
        localStorage.setItem(
            "engines",
            JSON.stringify([
                {
                    type: "local",
                    id: "config-failure-narrow",
                    name: "Gespeicherte Engine",
                    version: "18",
                    filename: "stockfish",
                    handle: { id: { id: "config-failure-binary" }, kind: "engine" },
                    settings: [],
                },
            ]),
        );
    });
    await mockScenario({
        commands: {
            file_exists: { result: true },
            get_engine_config: {
                error: {
                    tag: "backend-error",
                    category: "engine-timeout",
                    message: "Engine configuration timed out.",
                },
            },
        },
    });
    await page.goto("/engines?selected=0");
    const name = page.getByRole("textbox", { name: "Name", exact: true });
    await expect(name).toHaveValue("Gespeicherte Engine");
    await expect(name).toBeEditable();
    await name.scrollIntoViewIfNeeded();
    const originalNameStyle = await name.getAttribute("style");
    try {
        await name.evaluate((input) => {
            input.style.transform = "translateX(500px)";
        });
        let displacedErrorMessage = "";
        try {
            await assertNothingClipped(name, { mode: "reachable" });
        } catch (error) {
            displacedErrorMessage = error instanceof Error ? error.message : String(error);
        }
        expect(displacedErrorMessage).toMatch(/content clipped/);
    } finally {
        await name.evaluate((input, style) => {
            if (style === null) input.removeAttribute("style");
            else input.setAttribute("style", style);
        }, originalNameStyle);
    }
    expect(await name.getAttribute("style")).toBe(originalNameStyle);
    let strictErrorMessage = "";
    try {
        await assertNothingClipped(name);
    } catch (error) {
        strictErrorMessage = error instanceof Error ? error.message : String(error);
    }
    expect(strictErrorMessage).toMatch(/content clipped/);
    await assertNativeTextValueReachable(name, "Gespeicherte Engine");
    await assertNothingClipped(name, { mode: "reachable" });
    const failure = page.getByRole("alert");
    await expect(failure).toContainText(germanListingCopy["Common.Error"]);
    await expect(failure).toContainText("Engine configuration timed out.");
    await failure.scrollIntoViewIfNeeded();
    await expect(failure).toBeInViewport({ ratio: 1 });
    await assertNothingClipped(failure, { mode: "reachable" });
    await assertNoHorizontalOverflow();
    await capture("engine-config-error-320-200-de");
    await expect(failure).toHaveScreenshot("engine-config-error-320-200-de.png");
});

test("engine editor: refused cloud draft settles at 320px and 200% German", async ({
    page,
    mockScenario,
    capture,
    assertNoHorizontalOverflow,
}) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.addInitScript(() =>
        localStorage.setItem(
            "engines",
            JSON.stringify([
                {
                    type: "lichess",
                    id: "narrow-cloud",
                    name: "Committed cloud",
                    url: "https://lichess.org",
                    settings: [{ type: "string", name: "MultiPV", value: "1" }],
                },
            ]),
        ),
    );
    await mockScenario({
        commands: { reconcile_engine_attachments: { result: null, delay: 700 } },
    });
    await page.goto("/engines?selected=0");
    const name = page.getByRole("textbox", { name: "Name", exact: true });
    await name.scrollIntoViewIfNeeded();
    await expect(name).toBeVisible();
    await expect(name).toHaveValue("Committed cloud");
    await assertNativeTextValueReachable(name, "Committed cloud");
    await assertNothingClipped(name, { mode: "reachable" });
    await expect(name).toBeEditable();
    await assertNoHorizontalOverflow();
    const bytes = await page.evaluate(() => localStorage.getItem("engines"));
    await page.evaluate(() => {
        const original = Storage.prototype.setItem;
        Object.assign(window, {
            __restoreNarrowEngineStorage: () => {
                Storage.prototype.setItem = original;
            },
        });
        Storage.prototype.setItem = function (key, value) {
            if (key === "engines")
                throw new DOMException("Refused engine save", "QuotaExceededError");
            original.call(this, key, value);
        };
    });
    try {
        await name.fill("Refused cloud");
        await expect(name).toHaveValue("Refused cloud");
        await expect(page.getByText("Committed cloud", { exact: true })).toBeVisible();
        await capture("engine-cloud-draft-pending-320-200-de");
        await expect(name).toHaveValue("Committed cloud");
        await expect(
            page.getByText(/Die Engineliste konnte nicht gespeichert werden/).first(),
        ).toBeVisible();
        expect(await page.evaluate(() => localStorage.getItem("engines"))).toBe(bytes);
        await capture("engine-cloud-draft-refused-320-200-de");
        const remove = page.getByRole("button", { name: "Entfernen", exact: true });
        await remove.scrollIntoViewIfNeeded();
        await assertNothingClipped(remove, { mode: "reachable" });
        await assertNoHorizontalOverflow();
        await remove.click();
        await expect(page.getByText("Committed cloud", { exact: true })).toBeVisible();
        expect(await page.evaluate(() => localStorage.getItem("engines"))).toBe(bytes);
    } finally {
        await page.evaluate(() =>
            (
                window as typeof window & { __restoreNarrowEngineStorage: () => void }
            ).__restoreNarrowEngineStorage(),
        );
    }
});

async function setTitleBarFontScale(page: Page, scale: 100 | 200) {
    await page.getByRole("tab", { name: "Erscheinungsbild", exact: true }).click();
    const slider = page.getByRole("slider", { name: "Schriftgröße", exact: true });
    await slider.focus();
    await page.keyboard.press("Home");
    for (let step = 0; step < (scale - 50) / 10; step++) await page.keyboard.press("ArrowRight");
    await expect(slider).toHaveAttribute("aria-valuenow", String(scale));
    await expect(page.locator("html")).toHaveCSS("font-size", scale === 100 ? "16px" : "32px");
    // Root font-size changes restart the Switch track margin and thumb position transitions.
    await waitForTransitionsSettled(page);
    return slider;
}

async function assertMenuPanelsFit(page: Page) {
    for (const panel of await page.getByRole("menu").all()) {
        const box = (await panel.boundingBox())!;
        const viewport = page.viewportSize()!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
        await assertNothingClipped(panel, { mode: "reachable" });
        for (const item of await panel.locator(":scope > [role=menuitem]").all()) {
            await item.scrollIntoViewIfNeeded();
            await assertNothingClipped(item);
        }
    }
    await assertPageNotClipped(page);
}

async function assertCompactTitleBar(page: Page, controls = true) {
    const header = page.locator("header");
    const target = header.getByRole("button", { name: "Anwendungsmenü", exact: true });
    await expect(
        target,
        "compact application-menu affordance is visible without scrolling",
    ).toBeVisible();
    await expect(header.locator("img")).toHaveCount(0);
    const headerBox = (await header.boundingBox())!;
    const targetBox = (await target.boundingBox())!;
    expect(targetBox.width).toBe(64);
    expect(targetBox.x).toBeGreaterThanOrEqual(0);
    expect(targetBox.y).toBeGreaterThanOrEqual(headerBox.y);
    expect(targetBox.y + targetBox.height).toBeLessThanOrEqual(headerBox.y + headerBox.height);
    expect(targetBox.x + targetBox.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    const windowButtons = header.getByRole("button", { name: /^Fenster / });
    await expect(windowButtons).toHaveCount(controls ? 3 : 0);
    for (const button of await windowButtons.all()) {
        const box = (await button.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(targetBox.x + targetBox.width);
        expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
        expect(box.y + box.height).toBeLessThanOrEqual(headerBox.y + headerBox.height);
    }
    const exposed = await target.evaluate((button) => {
        const box = button.getBoundingClientRect();
        return (
            [1, box.width - 1].every((x) =>
                button.contains(document.elementFromPoint(box.x + x, box.y + box.height / 2)),
            ) && !button.hasAttribute("data-tauri-drag-region")
        );
    });
    expect(exposed, "whole target is exposed and interactive").toBe(true);
    const dragBox = (await header.locator("[data-tauri-drag-region]").last().boundingBox())!;
    expect(dragBox.width, "remaining title-bar drag area").toBeGreaterThan(0);
    await assertNothingClipped(header);
    await assertPageNotClipped(page);
    return target;
}

async function assertCompactGroups(page: Page) {
    for (const name of ["Datei", "Ansicht", "Hilfe"]) {
        const item = page.getByRole("menuitem", { name, exact: true });
        await expect(item).toBeVisible();
        await assertNothingClipped(item);
    }
    const root = page.getByRole("menu");
    expect(await root.evaluate((node) => node.scrollHeight <= node.clientHeight)).toBe(true);
    await assertMenuPanelsFit(page);
}

test("compact title-bar: mouse actions and German popup geometry at 320px / 200%", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
    capture,
}) => {
    await mockScenario({
        commands: {
            "plugin:window|destroy": { result: null },
            "plugin:window|is_fullscreen": { result: false },
            "plugin:window|set_fullscreen": { result: null },
        },
    });
    await page.goto("/library");
    const target = await assertCompactTitleBar(page);
    await target.click();
    await assertCompactGroups(page);
    await capture("compact-menu-root");
    await expect(page).toHaveScreenshot("compact-menu-root.png", { fullPage: true });
    for (const [group, action, command] of [
        ["Datei", "Beenden", "plugin:window|destroy"],
        ["Ansicht", "Vollbild F11", "plugin:window|set_fullscreen"],
        ["Hilfe", "Über", null],
    ] as const) {
        if (group !== "Datei") await target.click();
        // Hover and pointer entry must work even when the shifted submenu overlaps its parent.
        await page.getByRole("menuitem", { name: group, exact: true }).hover();
        const option = page.getByRole("menuitem", { name: action, exact: true });
        await expect(option).toBeVisible();
        await option.hover();
        await assertMenuPanelsFit(page);
        await capture(`compact-menu-${group}`);
        await option.click();
        await expect(page.getByRole("menu")).toHaveCount(0);
        if (command) {
            await expect
                .poll(() =>
                    page.evaluate(
                        (value) =>
                            window.__E2E_TAURI__
                                .invocations()
                                .filter((entry) => entry.command === value).length,
                        command,
                    ),
                )
                .toBe(1);
        } else await expect(page.getByRole("dialog", { name: "ChessRiddle Studio" })).toBeVisible();
    }
    await assertNoHorizontalOverflow();
    await assertPageNotClipped(page);
});

test("compact title-bar: all groups and actions by keyboard", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
}) => {
    await mockScenario({
        commands: {
            "plugin:window|destroy": { result: null },
            "plugin:window|is_fullscreen": { result: false },
            "plugin:window|set_fullscreen": { result: null },
        },
    });
    await page.goto("/library");
    const target = await assertCompactTitleBar(page);
    for (const [index, group] of ["Datei", "Ansicht", "Hilfe"].entries()) {
        await target.focus();
        await page.keyboard.press(index === 1 ? "Space" : "Enter");
        await expect(page.locator("[data-autofocus]")).toBeFocused();
        await page.keyboard.press("ArrowDown");
        for (let move = 0; move < index; move++) await page.keyboard.press("ArrowDown");
        const item = page.getByRole("menuitem", { name: group, exact: true });
        await expect(item).toBeFocused();
        await page.keyboard.press("ArrowRight");
        const first = page.getByRole("menuitem", {
            name: ["Neuer Tab", "Neu laden", "Dokumentation"][index]!,
            exact: false,
        });
        await expect(first).toBeFocused();
        await page.keyboard.press("ArrowLeft");
        await expect(item).toBeFocused();
        await page.keyboard.press(index === 1 ? "Space" : "Enter");
        await expect(first).toBeFocused();
        await page.keyboard.press("End");
        await expect(
            page.getByRole("menuitem", {
                name: ["Beenden", "Vollbild F11", "Über"][index]!,
                exact: true,
            }),
        ).toBeFocused();
        await assertMenuPanelsFit(page);
        await page.keyboard.press("Enter");
        await expect(page.getByRole("menu")).toHaveCount(0);
        if (index === 2) {
            const dialog = page.getByRole("dialog", { name: "ChessRiddle Studio" });
            await expect(dialog).toBeVisible();
            await dialog.getByRole("button", { name: "Dialog schließen" }).click();
        }
    }
    for (const command of ["plugin:window|destroy", "plugin:window|set_fullscreen"]) {
        expect(
            await page.evaluate(
                (value) =>
                    window.__E2E_TAURI__.invocations().filter((entry) => entry.command === value)
                        .length,
                command,
            ),
        ).toBe(1);
    }
    await target.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-autofocus]")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(target).toBeFocused();
    await assertNoHorizontalOverflow();
    await assertPageNotClipped(page);
});

test("compact title-bar: wide baseline, resizing and live font scaling preserve focus", async ({
    page,
    assertNoHorizontalOverflow,
    capture,
}) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/settings");
    const slider = await setTitleBarFontScale(page, 100);
    const header = page.locator("header");
    await expect(header.getByRole("button", { name: "Datei", exact: true })).toBeVisible();
    // Recorded before production edits in wide-baseline/geometry.json, pinned renderer, de-DE.
    expect(await header.boundingBox()).toEqual({ x: 0, y: 0, width: 1280, height: 36 });
    expect(await header.locator("img").boundingBox()).toEqual({
        x: 12,
        y: 8,
        width: 20,
        height: 20,
    });
    // Inter changes text widths while the title bar keeps its height and window-control space.
    const boxes = [
        ["Datei", 42, 7, 48, 22],
        ["Ansicht", 90, 7, 61, 22],
        ["Hilfe", 151, 7, 44, 22],
        ["Fenster minimieren", 1145, 0, 45, 36],
        ["Fenster maximieren", 1190, 0, 45, 36],
        ["Fenster schließen", 1235, 0, 45, 36],
    ] as const;
    for (const [name, x, y, width, height] of boxes)
        expect(await header.getByRole("button", { name, exact: true }).boundingBox()).toEqual({
            x,
            y,
            width,
            height,
        });
    await capture("title-bar-wide-100");
    await header.getByRole("button", { name: "Hilfe", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: "Über", exact: true }).focus();
    await page.setViewportSize({ width: 760, height: 720 });
    const target = header.getByRole("button", { name: "Anwendungsmenü", exact: true });
    await expect(target).toBeFocused();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await target.press("Enter");
    await expect(page.locator("[data-autofocus]")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "Datei", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("menuitem", { name: /Neuer Tab/ })).toBeFocused();
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(header.getByRole("button", { name: "Datei", exact: true })).toBeFocused();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await slider.focus();
    await page.setViewportSize({ width: 760, height: 720 });
    await expect(slider).toBeFocused();
    await page.setViewportSize({ width: 1280, height: 720 });
    await setTitleBarFontScale(page, 200);
    await expect(target).toBeVisible();
    await expect(slider).toBeFocused();
    await assertCompactTitleBar(page);
    await setTitleBarFontScale(page, 100);
    await expect(target).toHaveCount(0);
    await expect(slider).toBeFocused();
    await assertNoHorizontalOverflow();
    await assertPageNotClipped(page);
});

test("compact title-bar: failed Custom installation preserves native decorations without controls", async ({
    page,
    assertNoHorizontalOverflow,
    capture,
}) => {
    await page.goto("/settings");
    await page.getByRole("tab", { name: "Erscheinungsbild", exact: true }).click();
    const selector = page.getByRole("textbox", { name: "Titelleiste", exact: true });
    await selector.click();
    await page.getByRole("option", { name: "Native", exact: true }).click();
    await expect(page.locator("header")).toHaveCount(0);
    await expect
        .poll(() =>
            page.evaluate(() =>
                window.__E2E_TAURI__
                    .invocations()
                    .some(
                        ({ command, args }) =>
                            command === "plugin:window|set_decorations" &&
                            (args as { value?: boolean }).value === true,
                    ),
            ),
        )
        .toBe(true);
    // Native has completed successfully. Configure the already loaded window before Custom.
    await page.evaluate(() =>
        window.__E2E_TAURI__.configure({
            commands: {
                "plugin:window|set_decorations": { error: "decoration installation refused" },
            },
        }),
    );
    await selector.click();
    await page.getByRole("option", { name: "Benutzerdefiniert", exact: true }).click();
    await expect(page.getByText("decoration installation refused", { exact: true })).toBeVisible();
    await page.locator(".mantine-Notification-closeButton").click();
    await expect(page.locator(".mantine-Notification-root")).toHaveCount(0);
    const target = await assertCompactTitleBar(page, false);
    await target.click();
    await assertCompactGroups(page);
    await capture("compact-menu-no-controls");
    for (const name of ["Datei", "Ansicht", "Hilfe"]) {
        const item = page.getByRole("menuitem", { name, exact: true });
        await item.click();
        await expect(page.getByRole("menu").last().getByRole("menuitem").first()).toBeFocused();
        await assertMenuPanelsFit(page);
        await page.keyboard.press("ArrowLeft");
        await expect(item).toBeFocused();
    }
    await page.keyboard.press("Escape");
    await expect(target).toBeFocused();
    await assertNoHorizontalOverflow();
    await assertPageNotClipped(page);
});

const listingReasons = [
    ["changed", "Files.LoadFailed.Changed", "Databases.LoadError.Changed"],
    ["missing", "Files.LoadFailed.Missing", "Databases.LoadError.RootMissing"],
    ["unusable", "Files.LoadFailed.Unusable", "Databases.LoadError.Unusable"],
    ["permission", "Files.LoadFailed.Permission", "Databases.LoadError.RootPermission"],
    ["too-large", "Files.LoadFailed.TooLarge", "Databases.LoadError.TooLarge"],
    [undefined, "Files.LoadFailed", "Databases.LoadError"],
] as const;

for (const [rootFailure, filesKey, databasesKey] of listingReasons) {
    const error = {
        tag: "backend-error",
        category: "io",
        message: "native listing diagnostic",
        ...(rootFailure ? { rootFailure } : {}),
    } as const satisfies ErrorPayload;
    test(`async-errors: Files listing ${rootFailure ?? "retry"} stays visible at 320px`, async ({
        page,
        mockScenario,
        assertNoHorizontalOverflow,
        capture,
    }) => {
        await mockScenario({
            commands: filesWorkspaceCommands([], {
                list_file_workspace: { error },
            }),
        });
        await page.goto("/library");
        await page.getByRole("button", { name: "Sammlung auswählen", exact: true }).click();
        const alert = page.getByRole("alert");
        await expect(alert).toBeVisible();
        await expect(alert).toHaveText(germanListingCopy[filesKey]);
        await alert.scrollIntoViewIfNeeded();
        await expect(
            page.getByRole("button", {
                name: germanListingCopy["Files.ChangeCollection"],
                exact: true,
            }),
        ).toBeVisible();
        await assertNoHorizontalOverflow();
        await assertFilesColumnsNotClipped(page);
        await assertPageNotClipped(page);
        await capture(`files-listing-${rootFailure ?? "retry"}`);
    });
    test(`async-errors: Databases listing ${rootFailure ?? "retry"} stays visible at 320px`, async ({
        page,
        mockScenario,
        assertNoHorizontalOverflow,
        capture,
    }) => {
        await mockScenario({ commands: { list_workspace_databases: { error } } });
        await page.goto("/library");
        const alert = page.getByRole("alert");
        await expect(alert).toBeVisible();
        await expect(alert).toContainText(germanListingCopy[databasesKey]);
        await alert.scrollIntoViewIfNeeded();
        const choose = page.getByRole("button", {
            name: germanListingCopy["Databases.ChooseFolder"],
            exact: true,
        });
        if (rootFailure) {
            await expect(choose).toBeVisible();
            await choose.scrollIntoViewIfNeeded();
            await assertNothingClipped(alert, { mode: "reachable" });
        } else await expect(choose).toHaveCount(0);
        await expect(
            page.getByText(germanListingCopy["Library.Empty"], { exact: true }),
        ).toHaveCount(0);
        await assertNoHorizontalOverflow();
        await assertPageNotClipped(page);
        await capture(`databases-listing-${rootFailure ?? "retry"}`);
    });
}

const refreshedDirectory = {
    ...openingDirectory,
    handle: { id: { id: "refreshed-directory" }, kind: "fileWorkspace" },
    name: "Refreshed",
};

async function assertDialogWithinViewport(dialog: Locator) {
    const dimensions = await dialog.evaluate((element) => ({
        content: element.scrollWidth,
        width: element.clientWidth,
        left: element.getBoundingClientRect().left,
        right: element.getBoundingClientRect().right,
        viewport: window.innerWidth,
    }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.width);
    expect(dimensions.left).toBeGreaterThanOrEqual(0);
    expect(dimensions.right).toBeLessThanOrEqual(dimensions.viewport);
}

async function submitPurgeAndOpenFailureDialog(
    page: Page,
    mockScenario: (scenario: MockScenario) => Promise<void>,
    purgeError: string | ErrorPayload,
) {
    await mockScenario({
        commands: filesWorkspaceCommands([[openingDirectory], [], [refreshedDirectory]], {
            trash_workspace_entry: { result: "11111111-1111-4111-8111-111111111111" },
            delete_workspace_trash_item: { error: purgeError },
        }),
    });
    await page.goto("/library");
    await page.getByRole("button", { name: "Sammlung auswählen" }).click();
    const deleteEntry = page
        .getByRole("treeitem", { name: "Openings", exact: true })
        .getByRole("button", { name: "Löschen" });
    await deleteEntry.click();

    const trashDialog = page.getByRole("dialog", {
        name: "In den Papierkorb verschieben",
        exact: true,
    });
    await trashDialog.getByRole("button", { name: "Löschen", exact: true }).click();
    await expect(page.getByText("Openings wurde in den Papierkorb verschoben.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Rückgängig", exact: true })).toBeVisible();
    await expect(
        page.getByRole("treeitem", { name: refreshedDirectory.name, exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Dauerhaft löschen", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Dauerhaft löschen", exact: true });
    await dialog.getByRole("button", { name: "Löschen", exact: true }).click();
    return dialog;
}

async function assertPurgeInvocationAndRefresh(page: Page) {
    const fileInvocations = await page.evaluate(() =>
        window.__E2E_TAURI__
            .invocations()
            .filter(({ command }) =>
                [
                    "issue_file_workspace",
                    "list_file_workspace",
                    "trash_workspace_entry",
                    "delete_workspace_trash_item",
                ].includes(command),
            ),
    );
    expect(fileInvocations.map(({ command }) => command)).toEqual([
        "issue_file_workspace",
        "list_file_workspace",
        "trash_workspace_entry",
        "list_file_workspace",
        "delete_workspace_trash_item",
        "list_file_workspace",
    ]);
    expect(fileInvocations[2]).toEqual({
        command: "trash_workspace_entry",
        args: { workspace, entry: openingDirectory.handle },
    });
    expect(fileInvocations[4]).toEqual({
        command: "delete_workspace_trash_item",
        args: { workspace, item: "11111111-1111-4111-8111-111111111111" },
    });
    expect(fileInvocations.filter(({ command }) => command === "list_file_workspace")).toHaveLength(
        3,
    );
}

test("async-errors: localizes directory-trash failures in the confirmation dialog", async ({
    page,
    mockScenario,
    assertAccessible,
    assertNoHorizontalOverflow,
}) => {
    await mockScenario({
        commands: filesWorkspaceCommands([[openingDirectory]], {
            trash_workspace_entry: { error: "private native diagnostic at /private/file.pgn" },
        }),
    });
    await page.goto("/library");
    await page.getByRole("button", { name: "Sammlung auswählen" }).click();
    await page
        .getByRole("treeitem", { name: "Openings", exact: true })
        .getByRole("button", { name: "Löschen" })
        .click();
    const dialog = page.getByRole("dialog", { name: "In den Papierkorb verschieben", exact: true });
    await dialog.getByRole("button", { name: "Löschen", exact: true }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
        "Die Aktion konnte nicht abgeschlossen werden. Bitte versuche es erneut.",
    );
    await expect(dialog.getByRole("button", { name: "Löschen", exact: true })).toBeEnabled();
    await expect(page.locator("body")).not.toContainText("private native diagnostic");
    await expect(page.locator("body")).not.toContainText("/private/file.pgn");
    await assertNoHorizontalOverflow();
    await assertPageNotClipped(page);
    await assertAccessible();
    await dialog.getByRole("button", { name: "Löschen", exact: true }).scrollIntoViewIfNeeded();
    await expect(page).toHaveScreenshot("confirmation-error.png", { fullPage: true });
});

test("async-errors: fits a selected PGN file and its card at 320px", async ({
    page,
    mockScenario,
    assertAccessible,
    assertNoHorizontalOverflow,
}) => {
    await mockScenario({
        commands: filesWorkspaceCommands([[openingDirectory, pgnFile]], pgnFileCommands),
    });
    await page.goto("/library");
    await page.getByRole("button", { name: "Sammlung auswählen" }).click();
    const fileRow = await selectFilesTreeRow(page, pgnFile.name);
    // Nothing before this line depends on the card, so an overflowing page fails here.
    await assertNoHorizontalOverflow();
    await assertPageNotClipped(page);
    await assertNothingClipped(fileRow);

    // By text: each tree row also carries an icon-only "Verschieben" button.
    for (const name of ["Umbenennen", "Verschieben", "Papierkorb"]) {
        await expect(page.locator("button", { hasText: new RegExp(`^${name}$`) })).toBeVisible();
    }
    await expect(page.getByRole("button", { name: "Partie öffnen", exact: true })).toBeVisible();
    await expect(page.getByText("Weiss - Schwarz")).toBeVisible();
    // Both columns with everything in them: the controls and tree, the action row and the card.
    await assertFilesColumnsNotClipped(page);
    await assertAccessible();
    // The page scrolls inside its own container, so a full-page capture is one screen. A window
    // tall enough for both stacked columns puts the whole card into the picture.
    await page.setViewportSize({ width: 320, height: 3200 });
    await assertFilesColumnsNotClipped(page);
    await expect(page).toHaveScreenshot("files-file-selected.png");
});

const partialRemovalPayload = {
    tag: "backend-error",
    category: "partial-removal",
    message: "typed native diagnostic at /private/purge-secret.pgn",
} as const satisfies ErrorPayload;

const durabilityUncertainPayload = {
    tag: "backend-error",
    category: "durability",
    message: "typed durability diagnostic at /private/durability-secret.pgn",
} as const satisfies ErrorPayload;

async function assertPurgeWarning(
    page: Page,
    dialog: Locator,
    diagnostic: string,
    warning: string,
    assertAccessible: () => Promise<void>,
    assertNoHorizontalOverflow: () => Promise<void>,
) {
    await expect(dialog).toBeVisible();
    const alert = dialog.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toHaveText(warning);
    await expect(alert).not.toHaveText(
        "Die Aktion konnte nicht abgeschlossen werden. Bitte versuche es erneut.",
    );
    await alert.scrollIntoViewIfNeeded();
    const alertBounds = await alert.evaluate((element) => {
        const dialog = element.closest('[role="dialog"]');
        if (!(dialog instanceof HTMLElement)) return null;
        let viewport = dialog;
        for (
            let candidate = element.parentElement;
            candidate && candidate !== dialog;
            candidate = candidate.parentElement
        ) {
            const style = window.getComputedStyle(candidate);
            if (
                candidate.scrollHeight > candidate.clientHeight &&
                (style.overflowY === "auto" || style.overflowY === "scroll")
            ) {
                viewport = candidate;
                break;
            }
        }
        const alertRect = element.getBoundingClientRect();
        const viewportRect = viewport.getBoundingClientRect();
        return {
            alertTop: alertRect.top,
            alertBottom: alertRect.bottom,
            viewportTop: viewportRect.top,
            viewportBottom: viewportRect.bottom,
        };
    });
    if (!alertBounds) throw new Error("Permanent-delete warning is outside its modal dialog");
    expect(alertBounds.alertTop).toBeGreaterThanOrEqual(alertBounds.viewportTop - 1);
    // A wrapped line box can extend a fraction of a pixel past the scrollport.
    expect(alertBounds.alertBottom).toBeLessThanOrEqual(alertBounds.viewportBottom + 1);
    await expect(page.locator("body")).not.toContainText(diagnostic);
    await expect(page.getByText("Openings wurde in den Papierkorb verschoben.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Rückgängig", exact: true })).toHaveCount(0);
    await expect(
        page.getByRole("treeitem", {
            name: refreshedDirectory.name,
            exact: true,
            includeHidden: true,
        }),
    ).toHaveCount(1);
    await expect(dialog.getByRole("button", { name: "Löschen", exact: true })).toBeEnabled();
    await assertDialogWithinViewport(dialog);
    await assertNoHorizontalOverflow();
    await assertPageNotClipped(page);
    await assertAccessible();
}

test("async-errors: keeps the partial-removal warning after permanent delete", async ({
    page,
    mockScenario,
    assertAccessible,
    assertNoHorizontalOverflow,
}) => {
    const dialog = await submitPurgeAndOpenFailureDialog(page, mockScenario, partialRemovalPayload);
    await assertPurgeWarning(
        page,
        dialog,
        "typed native diagnostic",
        "Ein Teil des Vorgangs wurde abgeschlossen. Die Anzeige entspricht möglicherweise nicht mehr dem aktuellen Stand.",
        assertAccessible,
        assertNoHorizontalOverflow,
    );
    await assertPurgeInvocationAndRefresh(page);
    await expect(page).toHaveScreenshot("purge-partial-removal.png", { fullPage: true });
});

test("async-errors: keeps the durability warning after permanent delete", async ({
    page,
    mockScenario,
    assertAccessible,
    assertNoHorizontalOverflow,
}) => {
    const dialog = await submitPurgeAndOpenFailureDialog(
        page,
        mockScenario,
        durabilityUncertainPayload,
    );
    await assertPurgeWarning(
        page,
        dialog,
        "typed durability diagnostic",
        germanCatalogue.translation["Common.DurabilityUncertain"],
        assertAccessible,
        assertNoHorizontalOverflow,
    );
    await assertPurgeInvocationAndRefresh(page);
    await expect(page).toHaveScreenshot("purge-durability-uncertain.png", { fullPage: true });
});

for (const locale of ["en-US", "de-DE"] as const) {
    for (const width of [320, 1280] as const) {
        test(`Files create durability notice: ${locale} at ${width}px`, async ({
            page,
            mockScenario,
            assertNoHorizontalOverflow,
        }) => {
            const copy =
                locale === "de-DE" ? germanCatalogue.translation : englishCatalogue.translation;
            await page.setViewportSize({ width, height: 720 });
            await page.addInitScript((language) => {
                localStorage.setItem("i18nextLng", language);
            }, locale);
            await mockScenario({
                commands: filesWorkspaceCommands([[pgnFile], [pgnFile]], {
                    create_workspace_file: { error: durabilityUncertainPayload },
                }),
            });
            await page.goto("/library");
            await page
                .getByRole("button", { name: copy["Files.ChooseCollection"], exact: true })
                .click();
            await page.getByRole("button", { name: copy["Files.CreateFile"], exact: true }).click();
            const dialog = page.getByRole("dialog", {
                name: copy["Files.CreateFile"],
                exact: true,
            });
            await dialog
                .getByRole("textbox", { name: copy["Common.Name"], exact: true })
                .fill("Durability note");
            await dialog.getByRole("button", { name: copy["Common.Confirm"], exact: true }).click();
            await expect(dialog).toHaveCount(0);
            const notification = page.locator(".mantine-Notification-root");
            await expect(notification).toHaveCount(1);
            await expect(notification).toContainText(copy["Common.DurabilityUncertain"]);
            await expect(notification).not.toContainText("typed durability diagnostic");
            await expect(page.locator("body")).not.toContainText(copy["Files.OperationFailed"]);
            await expectNotificationSettled(notification);
            await assertNothingClipped(notification, { mode: "reachable" });
            await assertNoHorizontalOverflow();
            await expect(notification).toBeInViewport({ ratio: 1 });
            await expect(notification).toHaveScreenshot(
                `files-create-durability-${locale}-${width}.png`,
                {
                    stylePath: fileURLToPath(
                        new URL("./notification-screenshot.css", import.meta.url),
                    ),
                },
            );
        });

        test(`Files trash durability confirm: ${locale} at ${width}px`, async ({
            page,
            mockScenario,
            assertNoHorizontalOverflow,
        }) => {
            const copy =
                locale === "de-DE" ? germanCatalogue.translation : englishCatalogue.translation;
            await page.setViewportSize({ width, height: 720 });
            await page.addInitScript((language) => {
                localStorage.setItem("i18nextLng", language);
            }, locale);
            await mockScenario({
                commands: filesWorkspaceCommands([[pgnFile], []], {
                    ...pgnFileCommands,
                    trash_workspace_entry: { error: durabilityUncertainPayload },
                    list_workspace_trash: {
                        results: [
                            { items: [], olderCount: 0, cursor: null },
                            {
                                items: [
                                    {
                                        item: "11111111-1111-4111-8111-111111111111",
                                        kind: "file",
                                        name: pgnFile.name,
                                        originalFolder: "",
                                        trashedSeconds: 1700000000,
                                        category: null,
                                    },
                                ],
                                olderCount: 0,
                                cursor: null,
                            },
                        ],
                    },
                }),
            });
            await page.goto("/library");
            await page
                .getByRole("button", { name: copy["Files.ChooseCollection"], exact: true })
                .click();
            await selectFilesTreeRow(page, pgnFile.name);
            await page.getByRole("button", { name: copy["Files.Trash"], exact: true }).click();
            const dialog = page.getByRole("dialog", {
                name: copy["Files.MoveToTrash"],
                exact: true,
            });
            await dialog.getByRole("button", { name: copy["Common.Delete"], exact: true }).click();
            await expect(dialog).toBeVisible();
            await expect(dialog.getByRole("alert")).toHaveText(copy["Common.DurabilityUncertain"]);
            await expect(page.locator(".mantine-Notification-root")).toHaveCount(0);
            await expect(page.locator("body")).not.toContainText("typed durability diagnostic");
            await expect(
                page.getByRole("region", { name: copy["Files.Trash"], exact: true }),
            ).toContainText(pgnFile.name);
            await expect(page.locator("body")).toContainText(
                copy["Files.MovedToTrash"].replaceAll("{{name}}", pgnFile.name),
            );
            await assertDialogWithinViewport(dialog);
            await assertNothingClipped(dialog, { mode: "reachable" });
            await assertNoHorizontalOverflow();
            await expect(dialog).toHaveScreenshot(`files-trash-durability-${locale}-${width}.png`);
        });
    }
}

test("async-errors: verifies German navigation and a delayed native rejection at 200% font scale", async ({
    page,
    mockScenario,
    assertAccessible,
    assertNoHorizontalOverflow,
    capture,
}) => {
    await mockScenario({
        commands: {
            get_database_workspace: { delay: 120, error: "database workspace unavailable" },
        },
    });
    await page.goto("/accounts");
    await page.getByRole("button", { name: "Hinzufügen" }).click();
    const accountDialog = page.getByRole("dialog", { name: "Hinzufügen" });
    await expect(accountDialog.getByLabel("Benutzername")).toBeVisible();
    // The dialog itself, open: its submit button used to cut its German label.
    await expect(accountDialog.getByRole("button", { name: "Hinzufügen" })).toBeVisible();
    await assertNoHorizontalOverflow();
    await assertPageNotClipped(page);
    await accountDialog.getByRole("button", { name: /Dialog schließen/i }).click();
    // The empty state's heading has to be there before "nothing clipped" means anything.
    await expect(page.getByRole("heading", { name: "Keine Konten verbunden" })).toBeVisible();
    await assertNoHorizontalOverflow();
    await assertPageNotClipped(page);

    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Einstellungen" })).toBeVisible();
    await expect(page.getByRole("tabpanel", { name: "Brett" })).toBeVisible();
    await assertNoHorizontalOverflow();
    await assertPageNotClipped(page);
    for (const tab of ["Erscheinungsbild", "Ton"]) {
        await page.getByRole("tab", { name: tab }).click();
        await expect(page.getByRole("tabpanel", { name: tab })).toBeVisible();
        await assertNoHorizontalOverflow();
        await assertPageNotClipped(page);
    }
    await page.getByRole("link", { name: "Bibliothek" }).click();

    await expect(page.getByRole("alert")).toContainText(
        /database workspace unavailable|Datenbanken konnten nicht geladen werden/i,
    );
    // Visible, not only present: the list holding it used to be squeezed to 0px.
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Bibliothek" })).toBeVisible();
    await assertNoHorizontalOverflow();
    await assertPageNotClipped(page);
    await assertAccessible();
    await capture("async-errors");
    await expect(page).toHaveScreenshot("async-errors.png", { fullPage: true });
});

/**
 * `Accounts` loads the shared database workspace on mount purely to offer an
 * import destination, and deliberately swallows a failure because the databases
 * page owns the visible retry and error state for that workspace
 * (`src/components/home/Accounts.tsx`). This pins what "swallowed" is allowed to
 * mean: the session still paints from renderer state, no unhandled rejection
 * escapes (the `page` fixture fails the test on one), the raw native diagnostic
 * never reaches the document, and the page stays accessible and free of
 * horizontal overflow at 320px with 200% font scale in German.
 *
 * The invocation assertion keeps the rest honest — it proves the failing
 * workspace path was actually exercised rather than never reached.
 */
test("async-errors: degrades to a usable account page when the database workspace fails", async ({
    page,
    mockScenario,
    assertAccessible,
    assertNoHorizontalOverflow,
    capture,
}) => {
    await page.addInitScript(() => {
        localStorage.setItem(
            "sessions",
            JSON.stringify([
                {
                    player: "E2E Spieler",
                    // Fixed, never `Date.now()`: the card renders this as a
                    // localised date, so a moving value would invalidate the
                    // committed screenshot every day.
                    updatedAt: Date.UTC(2026, 0, 15, 12),
                    lichess: { username: "e2e-player", account: {} },
                },
            ]),
        );
    });
    await mockScenario({
        commands: {
            get_database_workspace: { delay: 120, error: "database workspace unavailable" },
        },
    });

    await page.goto("/accounts");
    await expect(page.getByRole("button", { name: "Hinzufügen" })).toBeVisible();

    // The session and its Lichess card come from renderer state, not from native.
    await expect(page.getByText("E2E Spieler")).toBeVisible();
    await expect(page.getByRole("button", { name: "Erneuere Statistik" })).toBeVisible();

    const invokedWorkspace = await page.evaluate(() =>
        window.__E2E_TAURI__
            .invocations()
            .some(({ command }) => command === "get_database_workspace"),
    );
    expect(
        invokedWorkspace,
        "the failing workspace path was never exercised, so nothing below proves degradation",
    ).toBe(true);

    // A native diagnostic is backend-only; it must never reach the document.
    // Wait until the failed listing has rendered, so the next assertion is not vacuous.
    await expect(page.locator("body")).toContainText("Statistiken konnten nicht geladen werden");
    await expect(page.locator("body")).not.toContainText("database workspace unavailable");

    await assertNoHorizontalOverflow();
    await assertPageNotClipped(page);
    await assertAccessible();
    const historyWarning = page
        .getByRole("alert")
        .getByText(germanListingCopy["Home.Accounts.HistoryUnavailable"], { exact: true });
    await expect(historyWarning).toHaveCount(1);
    const historyWord = await historyWarning.evaluate((paragraph) => {
        if (paragraph.tagName !== "P") throw new Error("history warning must be a real paragraph");
        const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
        const matches: { node: Text; start: number }[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            for (const match of (node as Text).data.matchAll(/\bnicht\b/g)) {
                matches.push({ node: node as Text, start: match.index });
            }
        }
        if (matches.length !== 1) {
            throw new Error(
                `history warning must contain one text-node match for nicht, found ${matches.length}`,
            );
        }
        const range = document.createRange();
        range.setStart(matches[0].node, matches[0].start);
        range.setEnd(matches[0].node, matches[0].start + "nicht".length);
        const main = paragraph.closest("main");
        if (!main) throw new Error("history warning must belong to the real main area");
        const mainStyle = getComputedStyle(main);
        const bounds = range.getBoundingClientRect();
        return {
            text: range.toString(),
            width: bounds.width,
            height: bounds.height,
            mainWidth:
                main.clientWidth -
                Number.parseFloat(mainStyle.paddingLeft) -
                Number.parseFloat(mainStyle.paddingRight),
            rects: Array.from(range.getClientRects(), (rect) => ({
                top: rect.top,
                width: rect.width,
                height: rect.height,
            })),
        };
    });
    expect(historyWord.text).toBe("nicht");
    expect(historyWord.width).toBeGreaterThan(0);
    expect(historyWord.height).toBeGreaterThan(0);
    expect(historyWord.rects.length).toBeGreaterThan(0);
    for (const rect of historyWord.rects) {
        expect(rect.width).toBeGreaterThan(0);
        expect(rect.height).toBeGreaterThan(0);
    }
    expect(historyWord.mainWidth).toBeGreaterThan(0);
    expect(
        historyWord.mainWidth,
        "the available main area must fit the complete warning word nicht",
    ).toBeGreaterThanOrEqual(historyWord.rects.reduce((width, rect) => width + rect.width, 0));
    expect(
        new Set(historyWord.rects.map((rect) => rect.top)).size,
        "history warning word nicht must occupy one rendered line instead of glyph rows",
    ).toBe(1);
    await capture("async-errors-personal-database");
    await expect(page).toHaveScreenshot("async-errors-personal-database.png", { fullPage: true });
    await page.getByRole("alert").scrollIntoViewIfNeeded();
    await capture("async-errors-personal-history-warning");
});

test("async-errors: wraps a long database title in the list at 320px", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
}) => {
    const title = "Eröffnungsdatenbankzusammenstellung";
    await mockScenario({
        commands: databaseCommands("long-title", "long-title.db3", {
            title,
            description: "",
            player_count: 0,
            event_count: 0,
            game_count: 0,
            storage_size: "0",
            indexed: false,
        }),
    });
    await page.goto("/library");
    // One unbroken word, wider than the stacked panel at 200%: it has to wrap, not be cut.
    await expect(page.getByText(title)).toBeVisible();
    await assertNoHorizontalOverflow();
    await assertPageNotClipped(page);
});
