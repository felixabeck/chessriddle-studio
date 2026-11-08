import {
    activeWorkspaceTab,
    assertNothingClipped,
    drawMark,
    playBoardMove,
    preserveStorageForReload,
    expect,
    expectNotificationSettled,
    test,
    type MockScenario,
} from "./fixtures";
import {
    decodeCompressedOrJson,
    deserializeStorageValue,
    serializeStorageValue,
} from "../src/state/store/debouncedStorage";
import type { TreeState } from "../src/utils/treeReducer";
import type { Locator, Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import bundledEngineCatalog from "../src/catalogs/engines.json" with { type: "json" };
import english from "../src/translation/en-US.json" with { type: "json" };
import polish from "../src/translation/pl-PL.json" with { type: "json" };
import french from "../src/translation/fr-FR.json" with { type: "json" };
import german from "../src/translation/de-DE.json" with { type: "json" };

async function assertCatalogActionReachable(action: Locator, cancel: Locator) {
    await action.scrollIntoViewIfNeeded();
    await expect(action).toBeDisabled();
    await expect(cancel).toBeVisible();
    await expect(cancel).toBeEnabled();
    await expect(action.locator(".mantine-Button-label")).not.toHaveCSS(
        "text-overflow",
        "ellipsis",
    );
    await expect(action.locator(".mantine-Button-label > span")).not.toHaveCSS(
        "text-overflow",
        "ellipsis",
    );
    // The label's ancestors include the button. Its decorative absolute progress fill
    // deliberately extends past the label, so it is not part of the text reachability check.
    await assertNothingClipped(action.locator(".mantine-Button-label > span"), {
        mode: "reachable",
    });
    await assertNothingClipped(cancel, { mode: "reachable" });
    const actionBox = await action.boundingBox();
    const cancelBox = await cancel.boundingBox();
    expect(actionBox).not.toBeNull();
    expect(cancelBox).not.toBeNull();
    expect(cancelBox!.x).toBeGreaterThanOrEqual(actionBox!.x + actionBox!.width);
    expect(cancelBox!.y).toBeGreaterThanOrEqual(actionBox!.y - 1);
    expect(cancelBox!.y + cancelBox!.height).toBeLessThanOrEqual(
        actionBox!.y + actionBox!.height + 1,
    );
    const cancelSize = await cancel.evaluate(
        () => parseFloat(getComputedStyle(document.documentElement).fontSize) * 2.125,
    );
    expect(Math.abs(cancelBox!.width - cancelSize)).toBeLessThanOrEqual(1);
    expect(Math.abs(cancelBox!.height - cancelSize)).toBeLessThanOrEqual(1);
}

for (const kind of ["add", "upgrade"] as const) {
    for (const corner of [
        { locale: "en-US", width: 1440, scale: 100, copy: english.translation },
        { locale: "pl-PL", width: 320, scale: 200, copy: polish.translation },
        { locale: "fr-FR", width: 320, scale: 200, copy: french.translation },
    ]) {
        for (const phase of ["Downloading", "Extracting"] as const) {
            test(`catalog active label: ${kind} ${corner.locale} ${phase}`, async ({
                page,
                mockScenario,
                capture,
                assertNoHorizontalOverflow,
            }) => {
                await page.setViewportSize({ width: corner.width, height: 900 });
                await page.addInitScript(
                    ({ locale, scale, engines }) => {
                        localStorage.setItem("i18nextLng", locale);
                        localStorage.setItem("font-size", String(scale));
                        localStorage.setItem("engines", engines);
                    },
                    {
                        locale: corner.locale,
                        scale: corner.scale,
                        engines: serializeStorageValue(
                            kind === "upgrade"
                                ? [
                                      {
                                          type: "local",
                                          id: "catalog-label-target",
                                          legacyAssessment: null,
                                          name: "Original Engine",
                                          version: "1",
                                          handle: { id: { id: "original-binary" }, kind: "engine" },
                                          filename: "old",
                                          settings: [],
                                      },
                                  ]
                                : [],
                        ),
                    },
                );
                await mockScenario({
                    commands: {
                        is_bmi2_compatible: { result: false },
                        verify_signed_bytes: { result: null },
                        get_progress: { result: null },
                        file_exists: { result: true },
                    },
                });
                await page.goto(kind === "upgrade" ? "/engines?selected=0" : "/engines");
                const title =
                    corner.copy[kind === "add" ? "Engines.Add.Title" : "Engines.Upgrade.Title"];
                await page
                    .getByRole("button", {
                        name: kind === "add" ? corner.copy["Common.AddNew"] : title,
                        exact: true,
                    })
                    .click();
                const dialog = page.getByRole("dialog", { name: title, exact: true });
                await expect(
                    dialog
                        .getByRole("button", { name: corner.copy["Common.Install"], exact: true })
                        .first(),
                ).toBeVisible();
                await expect
                    .poll(() =>
                        page.evaluate(() =>
                            window.__E2E_TAURI__
                                .invocations()
                                .some(({ command }) => command === "get_progress"),
                        ),
                    )
                    .toBe(true);
                await page.evaluate(
                    (progress) => {
                        const call = window.__E2E_TAURI__
                            .invocations()
                            .find(({ command }) => command === "get_progress")!;
                        const { id } = call.args as { id: string };
                        window.__E2E_TAURI__.emit("progress-event", {
                            id,
                            generation: "7",
                            state: "running",
                            progress,
                            finished: false,
                            cleared: false,
                        });
                    },
                    phase === "Downloading" ? 37 : 100,
                );
                const label = corner.copy[`Common.${phase}`];
                const name = `${label} ${phase === "Downloading" ? 37 : 100}%`;
                const action = dialog.getByRole("button", { name, exact: true });
                await expect(action).toHaveAccessibleName(name);
                const card = dialog.locator(".mantine-Paper-root").filter({
                    has: page.getByRole("button", { name, exact: true }),
                });
                const portrait = card.locator("img");
                await expect(portrait).toBeVisible();
                const geometry = await portrait.evaluate(
                    (image, expectedRem) => {
                        const box = image.parentElement!;
                        const text = box.nextElementSibling!;
                        return {
                            width: box.getBoundingClientRect().width,
                            expectedWidth:
                                expectedRem *
                                parseFloat(getComputedStyle(document.documentElement).fontSize),
                            portraitRight: box.getBoundingClientRect().right,
                            portraitBottom: box.getBoundingClientRect().bottom,
                            textLeft: text.getBoundingClientRect().left,
                            textTop: text.getBoundingClientRect().top,
                        };
                    },
                    kind === "add" ? 1.75 : 4,
                );
                expect
                    .soft(
                        Math.abs(geometry.width - geometry.expectedWidth),
                        `portrait border box ${geometry.width}px, expected ${geometry.expectedWidth}px`,
                    )
                    .toBeLessThanOrEqual(1);
                if (corner.width === 1440)
                    expect(geometry.textLeft).toBeGreaterThanOrEqual(geometry.portraitRight - 1);
                if (corner.width === 320 && kind === "upgrade")
                    expect
                        .soft(geometry.textTop, "narrow upgrade text stacks below the portrait")
                        .toBeGreaterThanOrEqual(geometry.portraitBottom - 1);
                await assertCatalogActionReachable(
                    action,
                    card.getByRole("button", { name: corner.copy["Common.Cancel"], exact: true }),
                );
                await assertNoHorizontalOverflow();
                await capture(`catalog-active-${kind}-${corner.locale}-${phase}`);
            });
        }
    }
}

for (const layout of ["desktop", "narrow"] as const) {
    test(`accounts-puzzles-engines: saved catalog portraits survive reload ${layout}`, async ({
        page,
        mockScenario,
        capture,
        assertNoHorizontalOverflow,
    }) => {
        // Resolve the actual bundled URL, even for a build unlike the mocked host's platform.
        const catalogEngine = bundledEngineCatalog.find(
            (entry) => entry.os === "windows" && entry.bmi2 && entry.image,
        )!;
        const savedEngine = {
            type: "local",
            id: "saved-catalog-engine",
            legacyAssessment: null,
            name: "Saved catalog engine",
            version: catalogEngine.version,
            filename: "saved-engine",
            handle: { id: { id: "saved-catalog-binary" }, kind: "engine" },
            downloadLink: catalogEngine.downloadLink,
            settings: [],
        };
        if (layout === "narrow") await page.setViewportSize({ width: 320, height: 900 });
        await page.addInitScript(
            (engines) => {
                if (localStorage.getItem("engines") === null)
                    localStorage.setItem("engines", engines);
                localStorage.setItem("font-size", "100");
                localStorage.setItem("i18nextLng", "en-US");
            },
            serializeStorageValue([savedEngine]),
        );
        await mockScenario({
            commands: {
                file_exists: { result: true },
                verify_signed_bytes: { result: null },
            },
        });
        await page.goto("/engines?selected=0");
        const card = page
            .getByRole("button", { pressed: true })
            .filter({ hasText: savedEngine.name });
        const editor = page.getByRole("button", { name: "Select image", exact: true });
        const assertPortraits = async (surfaces = [card, editor]) => {
            for (const surface of surfaces) {
                const image = surface.getByRole("img", { name: savedEngine.name, exact: true });
                await expect(image).toHaveAttribute("src", catalogEngine.image);
                await expect(image).toBeVisible();
                await expect
                    .poll(() =>
                        image.evaluate(
                            (node: HTMLImageElement) => node.complete && node.naturalWidth > 0,
                        ),
                    )
                    .toBe(true);
            }
        };
        await assertPortraits();
        await assertNoHorizontalOverflow();
        await capture(`saved-catalog-portraits-${layout}`);
        const saved = await page.evaluate(() => localStorage.getItem("engines"));
        await preserveStorageForReload(page);
        await assertPortraits();
        expect(await page.evaluate(() => localStorage.getItem("engines"))).toBe(saved);
        await assertNoHorizontalOverflow();
        if (layout === "narrow") await editor.scrollIntoViewIfNeeded();
        await capture(`saved-catalog-portraits-reloaded-${layout}`);
        await page.getByRole("link", { name: "Board", exact: true }).click();
        await page.getByRole("button", { name: /^open$/i }).click();
        await page.getByRole("tab", { name: "Analysis", exact: true }).click();
        await page.getByRole("button", { name: "Select engines", exact: true }).click();
        const picker = page.locator(".mantine-Popover-dropdown");
        await expect(picker).toBeVisible();
        await assertPortraits([picker]);
        await expect(picker.getByRole("checkbox")).not.toBeChecked();
        expect(await page.evaluate(() => localStorage.getItem("engines"))).toBe(saved);
        await capture(`saved-catalog-portraits-analysis-picker-${layout}`);
    });
}

const rootPermissionError = {
    tag: "backend-error" as const,
    category: "permission" as const,
    message: "I/O failure",
    rootFailure: "permission" as const,
};
const rootPermissionCommands = {
    verify_signed_bytes: { result: null },
    is_bmi2_compatible: { result: false },
    get_progress: { result: null },
    prepare_download: { result: "permission-ticket" },
    get_engine_workspace: { result: { id: { id: "selected-engine-root" }, kind: "engineRoot" } },
    get_engine_config: { result: { name: "Stockfish 18", options: [] } },
};

for (const layout of ["desktop", "320-200"] as const) {
    for (const surface of ["puzzle", "add", "upgrade"] as const) {
        test(`root permission guidance: ${surface} ${layout}`, async ({
            page,
            mockScenario,
            assertNoHorizontalOverflow,
        }) => {
            if (layout === "320-200") await page.setViewportSize({ width: 320, height: 900 });
            await page.addInitScript(
                ({ layout, engines }) => {
                    localStorage.setItem("font-size", layout === "desktop" ? "100" : "200");
                    localStorage.setItem("i18nextLng", "en-US");
                    localStorage.setItem("engines", engines);
                },
                {
                    layout,
                    engines: serializeStorageValue(
                        surface === "upgrade"
                            ? [
                                  {
                                      type: "local",
                                      id: "prior-engine",
                                      legacyAssessment: null,
                                      name: "Stockfish 18",
                                      version: "18",
                                      filename: "old-stockfish",
                                      handle: { id: { id: "prior-binary" }, kind: "engine" },
                                      settings: [],
                                  },
                              ]
                            : [],
                    ),
                },
            );
            const boundary =
                surface === "puzzle" ? "list_puzzle_databases" : "install_engine_workflow";
            await mockScenario({
                commands: {
                    ...rootPermissionCommands,
                    [boundary]: { error: rootPermissionError },
                },
            });
            await page.goto(
                surface === "puzzle"
                    ? "/"
                    : surface === "upgrade"
                      ? "/engines?selected=0"
                      : "/engines",
            );
            const saved = await page.evaluate(() => localStorage.getItem("engines"));
            if (surface === "puzzle")
                await page.getByRole("button", { name: "Train", exact: true }).click();
            else {
                await page
                    .getByRole("button", {
                        name: surface === "add" ? "Add New" : "Upgrade from catalog",
                        exact: true,
                    })
                    .click();
                const dialog = page.getByRole("dialog", {
                    name: surface === "add" ? "Add Engine" : "Upgrade from catalog",
                    exact: true,
                });
                await dialog.getByRole("button", { name: "Install", exact: true }).first().click();
            }
            await page.mouse.move(0, 0);
            await page.keyboard.press("Escape");
            const notification = page.locator(".mantine-Notification-root");
            const guidance = notification.locator(".mantine-Notification-description");
            await expect(guidance).toHaveText(
                `ChessRiddle Studio is not allowed to read this ${surface === "puzzle" ? "puzzle" : "engine"} folder. Choose another in Settings.`,
            );
            await expectNotificationSettled(notification);
            expect(await page.evaluate(() => localStorage.getItem("engines"))).toBe(saved);
            expect(
                (await page.evaluate(() => window.__E2E_TAURI__.invocations())).some(
                    ({ command }) => command === boundary,
                ),
            ).toBe(true);
            await assertNoHorizontalOverflow();
            await assertNothingClipped(notification, { mode: "reachable" });
            await expect(guidance).toBeInViewport({ ratio: 1 });
            await expectNotificationTextReachable(
                notification,
                "all",
                surface === "puzzle" ? "puzzle" : "engine",
            );
            await expect(notification).toHaveScreenshot(
                `root-permission-${surface}-${layout}.png`,
                {
                    stylePath: fileURLToPath(
                        new URL("./notification-screenshot.css", import.meta.url),
                    ),
                },
            );
        });
    }
}

async function showPermissionNotifications(
    page: Page,
    mockScenario: (scenario: MockScenario) => Promise<void>,
    count: number,
) {
    const clockStart = new Date("2026-10-22T12:00:00Z");
    await page.clock.install({ time: clockStart });
    await page.addInitScript((engines) => {
        localStorage.setItem("font-size", "200");
        localStorage.setItem("i18nextLng", "en-US");
        localStorage.setItem("engines", engines);
    }, serializeStorageValue([]));
    await mockScenario({
        commands: {
            ...rootPermissionCommands,
            install_engine_workflow: { error: rootPermissionError },
        },
    });
    await page.goto("/engines");
    await page.getByRole("button", { name: "Add New", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add Engine", exact: true });
    await expect(
        dialog.getByRole("button", { name: "Install", exact: true }).first(),
    ).toBeVisible();
    // Let startup and the catalog finish before pausing notification expiry timers.
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
    for (let index = 0; index < count; index++) {
        await dialog.getByRole("button", { name: "Install", exact: true }).first().click();
        // Advance the paused application clock through transition timers, retaining production
        // expiry settings. Geometry still waits on the actual final CSS transform below.
        await page.clock.runFor(400);
        await expect(page.locator(".mantine-Notification-root")).toHaveCount(index + 1);
        await expectNotificationSettled(page.locator(".mantine-Notification-root").nth(index));
    }
    await page.keyboard.press("Escape");
    await page.clock.runFor(400);
    await expect(dialog).toBeHidden();
}

async function expectResizedNotificationSettled(notification: Locator) {
    await expectNotificationSettled(notification);
    const height = await notification.evaluate(
        (node) => getComputedStyle(node.closest(".mantine-Notifications-root")!).maxHeight,
    );
    // Resizing also animates max-height. Wait for the actual CSS viewport bound before measuring.
    await expect(notification).toHaveCSS("max-height", height);
}

async function expectNotificationTextReachable(
    notification: Locator,
    edge: "start" | "end" | "all",
    folder: "engine" | "puzzle" = "engine",
) {
    const geometry = await notification.evaluate((node, edge) => {
        const description = node.querySelector(".mantine-Notification-description")!;
        const range = document.createRange();
        range.selectNodeContents(description);
        const lines = [...range.getClientRects()].map((line) => ({
            x: line.x,
            y: line.y,
            right: line.right,
            bottom: line.bottom,
            width: line.width,
            height: line.height,
        }));
        const line = edge === "start" ? lines[0] : lines.at(-1)!;
        const descriptionBox = description.getBoundingClientRect();
        const style = getComputedStyle(description);
        const contentBox = {
            left:
                descriptionBox.left +
                parseFloat(style.borderLeftWidth) +
                parseFloat(style.paddingLeft),
            top:
                descriptionBox.top +
                parseFloat(style.borderTopWidth) +
                parseFloat(style.paddingTop),
            right:
                descriptionBox.right -
                parseFloat(style.borderRightWidth) -
                parseFloat(style.paddingRight),
            bottom:
                descriptionBox.bottom -
                parseFloat(style.borderBottomWidth) -
                parseFloat(style.paddingBottom),
        };
        const box = node.getBoundingClientRect();
        const container = node.closest(".mantine-Notifications-root")!.getBoundingClientRect();
        const x = line.x + line.width / 2;
        const y = line.y + line.height / 2;
        return {
            edge,
            text: description.textContent,
            lines,
            contentBox,
            line: { x: line.x, y: line.y, right: line.right, bottom: line.bottom },
            clip: {
                left: Math.max(0, box.left, container.left, contentBox.left),
                top: Math.max(0, box.top, container.top, contentBox.top),
                right: Math.min(innerWidth, box.right, container.right, contentBox.right),
                bottom: Math.min(innerHeight, box.bottom, container.bottom, contentBox.bottom),
            },
            x,
            y,
            pointerReaches: node.contains(document.elementFromPoint(x, y)),
            scrollTop: node.scrollTop,
            clientHeight: node.clientHeight,
            scrollHeight: node.scrollHeight,
        };
    }, edge);
    expect(geometry.text).toBe(
        `ChessRiddle Studio is not allowed to read this ${folder} folder. Choose another in Settings.`,
    );
    expect(geometry.lines.length).toBeGreaterThan(0);
    // Range rects measure the complete painted sentence even when Mantine permits ellipsis.
    for (const line of geometry.lines) {
        expect(line.x).toBeGreaterThanOrEqual(geometry.contentBox.left);
        expect(line.right).toBeLessThanOrEqual(geometry.contentBox.right);
    }
    for (const line of edge === "all" ? geometry.lines : [geometry.line]) {
        expect(line.x).toBeGreaterThanOrEqual(geometry.clip.left);
        expect(line.y).toBeGreaterThanOrEqual(geometry.clip.top);
        expect(line.right).toBeLessThanOrEqual(geometry.clip.right);
        expect(line.bottom).toBeLessThanOrEqual(geometry.clip.bottom);
    }
    expect(geometry.pointerReaches).toBe(true);
    console.log("ROOT_PERMISSION_REACHABILITY", JSON.stringify(geometry));
    return geometry;
}

async function dismissPermissionNotification(page: Page, notification: Locator, remaining: number) {
    const close = notification.locator(".mantine-Notification-closeButton");
    await expect(close).toBeInViewport({ ratio: 1 });
    const geometry = await close.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return {
            x: box.x,
            y: box.y,
            right: box.right,
            bottom: box.bottom,
            viewport: { width: innerWidth, height: innerHeight },
            pointerReaches: node.contains(
                document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
            ),
        };
    });
    expect(geometry.pointerReaches).toBe(true);
    console.log("ROOT_PERMISSION_DISMISS", JSON.stringify({ ...geometry, remaining }));
    await close.click();
    await page.clock.runFor(400);
    await expect(page.locator(".mantine-Notification-root")).toHaveCount(remaining);
}

test("root permission guidance: oversized notification remains reachable", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
}) => {
    await showPermissionNotifications(page, mockScenario, 1);
    await page.setViewportSize({ width: 320, height: 260 });
    const notification = page.locator(".mantine-Notification-root");
    await expectResizedNotificationSettled(notification);
    const box = await notification.evaluate((node) => ({
        scrollHeight: node.scrollHeight,
        height: node.clientHeight,
        viewport: innerHeight,
    }));
    expect(box.scrollHeight).toBeGreaterThan(box.viewport);
    expect(box.height).toBeLessThan(box.viewport);
    await assertNothingClipped(notification, { mode: "reachable" });
    await assertNoHorizontalOverflow();
    const start = await expectNotificationTextReachable(notification, "start");
    await page.mouse.move(start.x, start.y);
    await page.mouse.click(start.x, start.y);
    await page.mouse.wheel(0, 10000);
    await expect.poll(() => notification.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    await expect
        .poll(async () =>
            notification.evaluate(
                (node) => node.scrollTop + node.clientHeight >= node.scrollHeight - 1,
            ),
        )
        .toBe(true);
    const end = await expectNotificationTextReachable(notification, "end");
    await page.mouse.move(end.x, end.y);
    await page.mouse.click(end.x, end.y);
    await page.mouse.wheel(0, -10000);
    await expect.poll(() => notification.evaluate((node) => node.scrollTop)).toBe(0);
    await expectNotificationTextReachable(notification, "start");
    await dismissPermissionNotification(page, notification, 0);
});

test("root permission guidance: oversized stack remains reachable", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
}) => {
    await showPermissionNotifications(page, mockScenario, 3);
    await page.setViewportSize({ width: 320, height: 600 });
    const notifications = page.locator(".mantine-Notification-root");
    for (const notification of await notifications.all())
        await expectResizedNotificationSettled(notification);
    const container = page.locator('.mantine-Notifications-root[data-position="bottom-right"]');
    const geometry = await container.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return {
            top: box.top,
            bottom: box.bottom,
            height: node.clientHeight,
            scrollHeight: node.scrollHeight,
            viewport: innerHeight,
        };
    });
    console.log("ROOT_PERMISSION_STACK", JSON.stringify(geometry));
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.viewport);
    expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewport);
    await assertNothingClipped(container, { mode: "reachable" });
    await assertNoHorizontalOverflow();
    await expectNotificationTextReachable(notifications.first(), "start");
    await container.hover();
    await page.mouse.wheel(0, 10000);
    await expect
        .poll(() =>
            container.evaluate(
                (node) => node.scrollTop + node.clientHeight >= node.scrollHeight - 1,
            ),
        )
        .toBe(true);
    const end = await expectNotificationTextReachable(notifications.last(), "end");
    console.log(
        "ROOT_PERMISSION_STACK_SCROLL_END",
        await container.evaluate((node) => node.scrollTop),
    );
    await page.mouse.move(end.x, end.y);
    await page.mouse.click(end.x, end.y);
    await page.mouse.wheel(0, -10000);
    await expect.poll(() => container.evaluate((node) => node.scrollTop)).toBe(0);
    for (const remaining of [2, 1, 0]) {
        await expectNotificationTextReachable(notifications.first(), "start");
        await expectNotificationTextReachable(notifications.first(), "end");
        await dismissPermissionNotification(page, notifications.first(), remaining);
    }
});

async function refusePuzzleStorage(page: Page, target: string) {
    await page.evaluate((target) => {
        const original = Storage.prototype.setItem;
        Object.assign(window, {
            __restorePuzzleStorage: () => {
                Storage.prototype.setItem = original;
            },
        });
        Storage.prototype.setItem = function (key, value) {
            if (key === target)
                throw new DOMException("Puzzle storage refused", "QuotaExceededError");
            original.call(this, key, value);
        };
    }, target);
}

async function restorePuzzleStorage(page: Page) {
    await page.evaluate(() =>
        (window as typeof window & { __restorePuzzleStorage: () => void }).__restorePuzzleStorage(),
    );
}

test("accounts-puzzles-engines: default-true check stays disabled after save and reload and refusal restores true", async ({
    page,
    mockScenario,
    capture,
}) => {
    await page.addInitScript(() => {
        localStorage.setItem("font-size", "100");
        if (localStorage.getItem("engines") === null)
            localStorage.setItem(
                "engines",
                JSON.stringify([
                    {
                        type: "local",
                        id: "check-entry",
                        name: "Check engine",
                        version: "18",
                        filename: "stockfish",
                        handle: { id: { id: "check-binary" }, kind: "engine" },
                        settings: [],
                    },
                ]),
            );
    });
    await mockScenario({
        commands: {
            file_exists: { result: true },
            get_engine_config: {
                result: {
                    name: "Check engine",
                    options: [{ type: "check", value: { name: "Ponder", default: true } }],
                },
            },
            reconcile_engine_attachments: { result: null, delay: 700 },
        },
    });
    await page.goto("/engines?selected=0");
    const ponder = page.getByRole("checkbox", { name: "Ponder", exact: true });
    await expect(ponder).toBeChecked();
    const bytes = await page.evaluate(() => localStorage.getItem("engines"));
    await ponder.uncheck();
    await expect(ponder).not.toBeChecked();
    expect(await page.evaluate(() => localStorage.getItem("engines"))).toBe(bytes);
    await expect(ponder.locator("..").locator("svg")).toHaveCSS("opacity", "0");
    await expect(ponder).not.toBeChecked();
    expect(await page.evaluate(() => localStorage.getItem("engines"))).toBe(bytes);
    await capture("engine-check-false-pending");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("engines"))).not.toBe(bytes);
    await expect(ponder).not.toBeChecked();
    await page.evaluate(() => sessionStorage.setItem("__E2E_PRESERVE_STORAGE_ONCE__", "1"));
    await page.reload();
    await expect(ponder).not.toBeChecked();
    await capture("engine-check-false-rehydrated");
    const falseBytes = await page.evaluate(() => localStorage.getItem("engines"));
    await ponder.check();
    await expect
        .poll(() => page.evaluate(() => localStorage.getItem("engines")))
        .not.toBe(falseBytes);
    await page.evaluate(() => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
            if (key === "engines")
                throw new DOMException("Engine storage refused", "QuotaExceededError");
            original.call(this, key, value);
        };
    });
    const trueBytes = await page.evaluate(() => localStorage.getItem("engines"));
    await ponder.uncheck();
    await expect(ponder).not.toBeChecked();
    await expect(page.getByText(/The engine list could not be saved/).first()).toBeVisible();
    await expect(ponder).toBeChecked();
    expect(await page.evaluate(() => localStorage.getItem("engines"))).toBe(trueBytes);
    await capture("engine-check-refused-restores-true");
});

test("accounts-puzzles-engines: current engine configuration failure keeps saved metadata usable", async ({
    page,
    mockScenario,
    capture,
}) => {
    await page.addInitScript(() => {
        localStorage.setItem("font-size", "100");
        localStorage.setItem(
            "engines",
            JSON.stringify([
                {
                    type: "local",
                    id: "config-failure-desktop",
                    name: "Saved engine",
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
    const failure = page.getByRole("alert");
    await expect(failure).toContainText("Error");
    await expect(failure).toContainText("Engine configuration timed out.");
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(
        "Saved engine",
    );
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toBeEditable();
    await failure.scrollIntoViewIfNeeded();
    await capture("engine-config-error-desktop");
    await expect(page).toHaveScreenshot("engine-config-error-desktop.png", { fullPage: true });
});

const summaryLichessDatabase = {
    handle: { id: { id: "summary-lichess" }, kind: "database" },
    filename: "alex_lichess.db3",
    availability: "available",
};
const summaryChessComDatabase = {
    handle: { id: { id: "summary-chesscom" }, kind: "database" },
    filename: "alex_chesscom.db3",
    availability: "available",
};
const summaryDatabaseInfo = {
    status: "ready",
    description: "",
    player_count: 1,
    event_count: 1,
    game_count: 8,
    storage_size: "1024",
    indexed: true,
};
const summaryLichessInfo = {
    ...summaryDatabaseInfo,
    title: "Alex Lichess",
    filename: summaryLichessDatabase.filename,
};
const summaryChessComInfo = {
    ...summaryDatabaseInfo,
    title: "Alex Chess.com",
    filename: summaryChessComDatabase.filename,
};
const summaryStatistics = {
    site_stats_data: [
        {
            site: "Lichess",
            player: "alex",
            daily: [
                {
                    date: "2026.10.04",
                    time_control: "600+0",
                    won: 5,
                    drawn: 2,
                    lost: 1,
                    max_player_elo: 1500,
                },
            ],
            colors: [
                {
                    time_control: "600+0",
                    is_player_white: true,
                    won: 5,
                    drawn: 2,
                    lost: 1,
                    rated_won: 5,
                    rated_drawn: 2,
                    rated_lost: 1,
                    opponent_elo_sum: 11_200,
                },
            ],
            latest: [
                {
                    time_control: "600+0",
                    date: "2026.10.04",
                    time: null,
                    game_id: 1,
                    player_elo: 1500,
                },
            ],
            openings: [],
        },
    ],
};

const homeSummaryPlayerStatisticsFixture = (player: string, won: number) => ({
    site_stats_data: [
        {
            ...summaryStatistics.site_stats_data[0],
            player,
            daily: [{ ...summaryStatistics.site_stats_data[0].daily[0], won, drawn: 0, lost: 0 }],
            colors: [
                {
                    ...summaryStatistics.site_stats_data[0].colors[0],
                    won,
                    drawn: 0,
                    lost: 0,
                    rated_won: won,
                    rated_drawn: 0,
                    rated_lost: 0,
                    opponent_elo_sum: won * 1400,
                },
            ],
        },
    ],
});

async function expectHomeSummaryDropdown(
    page: Page,
    assertNoHorizontalOverflow: () => Promise<void>,
) {
    const dropdown = page.locator(".mantine-Select-dropdown:visible");
    await expect(dropdown).toHaveCount(1);
    await expect
        .poll(
            () =>
                dropdown.evaluate((node) => {
                    const box = node.getBoundingClientRect();
                    return (
                        box.left >= 0 &&
                        box.right <= innerWidth &&
                        box.top >= 0 &&
                        box.bottom <= innerHeight
                    );
                }),
            { message: "home summary open dropdown must fit within the viewport" },
        )
        .toBe(true);
    await assertNoHorizontalOverflow();
    console.log("HOME_SUMMARY_DROPDOWN", JSON.stringify(await dropdown.boundingBox()));
}

async function expectHomeSummarySelectedText(input: Locator, value: string) {
    await expect(input).toHaveValue(value);
    await input.blur();
    await expect(input).not.toBeFocused();
    await expect(input).not.toHaveAttribute("aria-expanded", "true");
    await input.scrollIntoViewIfNeeded();
    const geometry = await input.evaluate(async (node: HTMLInputElement) => {
        await document.fonts.ready;
        const style = getComputedStyle(node);
        const measure = document.createElement("span");
        Object.assign(measure.style, {
            position: "fixed",
            visibility: "hidden",
            whiteSpace: "pre",
            font: style.font,
            letterSpacing: style.letterSpacing,
            textTransform: style.textTransform,
        });
        measure.textContent = node.value;
        document.body.append(measure);
        const textWidth = measure.getBoundingClientRect().width;
        measure.remove();
        const content = () => {
            const box = node.getBoundingClientRect();
            let left = box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
            let right =
                box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
            // Padding normally reserves Mantine's sections. Use their actual bounds too,
            // so a changed adornment cannot silently consume the measured text area.
            for (const section of node.parentElement!.querySelectorAll(".mantine-Input-section")) {
                const bounds = section.getBoundingClientRect();
                if (section.getAttribute("data-position") === "left")
                    left = Math.max(left, bounds.right);
                if (section.getAttribute("data-position") === "right")
                    right = Math.min(right, bounds.left);
            }
            return { left, right, top: box.top, bottom: box.bottom };
        };
        const localScrolls: number[] = [];
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
            const overflow = getComputedStyle(parent);
            const box = parent.getBoundingClientRect();
            const field = content();
            if (/(auto|scroll)/.test(overflow.overflowX)) {
                const left = box.left + parent.clientLeft;
                const right = left + parent.clientWidth;
                if (field.left < left) parent.scrollLeft += field.left - left;
                else if (field.left + textWidth > right)
                    parent.scrollLeft += field.left + textWidth - right;
                if (parent.scrollWidth > parent.clientWidth) localScrolls.push(parent.scrollLeft);
            }
        }
        const field = content();
        const clip = { left: 0, right: innerWidth, top: 0, bottom: innerHeight };
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
            const overflow = getComputedStyle(parent);
            const box = parent.getBoundingClientRect();
            if (/(auto|scroll|hidden|clip)/.test(overflow.overflowX)) {
                clip.left = Math.max(clip.left, box.left + parent.clientLeft);
                clip.right = Math.min(
                    clip.right,
                    box.left + parent.clientLeft + parent.clientWidth,
                );
            }
            if (/(auto|scroll|hidden|clip)/.test(overflow.overflowY)) {
                clip.top = Math.max(clip.top, box.top + parent.clientTop);
                clip.bottom = Math.min(
                    clip.bottom,
                    box.top + parent.clientTop + parent.clientHeight,
                );
            }
        }
        return {
            textWidth,
            usableWidth: field.right - field.left,
            field,
            clip,
            localScrolls,
            scrollLeft: node.scrollLeft,
        };
    });
    expect(geometry.scrollLeft, `${value}: closed input must rest at its text start`).toBe(0);
    expect(
        geometry.textWidth,
        `${value}: selected text must fit the usable closed input content area`,
    ).toBeLessThanOrEqual(geometry.usableWidth);
    expect(
        geometry.field.left,
        `${value}: text start reachable inside the card`,
    ).toBeGreaterThanOrEqual(geometry.clip.left - 1);
    expect(
        geometry.field.left + geometry.textWidth,
        `${value}: complete text reachable inside the card`,
    ).toBeLessThanOrEqual(geometry.clip.right + 1);
    expect(geometry.field.top).toBeGreaterThanOrEqual(geometry.clip.top - 1);
    expect(geometry.field.bottom).toBeLessThanOrEqual(geometry.clip.bottom + 1);
    console.log("HOME_SUMMARY_SELECTED_TEXT", value, JSON.stringify(geometry));
}

test("accounts-puzzles-engines: home summary retains mixed-case owner games after account selection", async ({
    page,
    mockScenario,
    capture,
    assertNoHorizontalOverflow,
}) => {
    await page.addInitScript(() => {
        localStorage.setItem(
            "sessions",
            JSON.stringify(
                ["alex", "other"].map((username) => ({
                    player: "Alex",
                    updatedAt: Date.UTC(2026, 9, 4),
                    lichess: { username, account: { id: username, username, perfs: {} } },
                })),
            ),
        );
    });
    await mockScenario({
        commands: {
            list_workspace_databases: { result: { entries: [summaryLichessDatabase], unread: [] } },
            get_db_info: { result: summaryLichessInfo },
            get_players: {
                result: {
                    data: [
                        { id: 7, name: "Alex", elo: 1500 },
                        { id: 8, name: "ALEX", elo: 1500 },
                    ],
                    count: 2,
                },
            },
            get_players_game_info: {
                outcomes: [
                    { result: homeSummaryPlayerStatisticsFixture("Alex", 3) },
                    { result: homeSummaryPlayerStatisticsFixture("ALEX", 5) },
                ],
                error: "Unexpected extra statistics read",
            },
        },
    });
    await page.goto("/accounts");
    const overview = page.getByRole("tabpanel", { name: "Overview", exact: true });
    const total = overview.getByText("8 Games", { exact: true });
    await expect(total).toBeVisible();
    await overview.getByRole("textbox", { name: "Website", exact: true }).click();
    await expectHomeSummaryDropdown(page, assertNoHorizontalOverflow);
    await page.getByRole("option", { name: "Lichess", exact: true }).click();
    await overview.getByRole("textbox", { name: "Account", exact: true }).click();
    await expectHomeSummaryDropdown(page, assertNoHorizontalOverflow);
    await page.getByRole("option", { name: "other", exact: true }).click();
    await expect(overview.getByText("0 Games", { exact: true })).toBeVisible();
    await overview.getByRole("textbox", { name: "Account", exact: true }).click();
    await expectHomeSummaryDropdown(page, assertNoHorizontalOverflow);
    await page.getByRole("option", { name: "alex", exact: true }).click();
    await expect(total).toBeVisible();
    await expectHomeSummarySelectedText(
        overview.getByRole("textbox", { name: "Website", exact: true }),
        "Lichess",
    );
    await expectHomeSummarySelectedText(
        overview.getByRole("textbox", { name: "Account", exact: true }),
        "alex",
    );
    await assertNoHorizontalOverflow();
    const reads = await page.evaluate(() =>
        window.__E2E_TAURI__
            .invocations()
            .filter(({ command }) => command === "get_players_game_info")
            .map(({ args }) => (args as { id: number }).id),
    );
    expect(reads).toEqual([7, 8]);
    await capture("home-summary-exact-player-account-selected");
});

for (const corner of [
    { width: 1440, scale: 100, locale: "en-US", copy: english.translation },
    { width: 800, scale: 100, locale: "en-US", copy: english.translation },
    { width: 800, scale: 200, locale: "en-US", copy: english.translation },
    { width: 320, scale: 100, locale: "en-US", copy: english.translation },
    { width: 320, scale: 200, locale: "de-DE", copy: german.translation },
]) {
    test(`accounts-puzzles-engines: home summary filters ${corner.width} ${corner.scale}% ${corner.locale}`, async ({
        page,
        mockScenario,
        capture,
        assertNoHorizontalOverflow,
    }) => {
        await page.setViewportSize({ width: corner.width, height: 900 });
        await page.addInitScript(
            ({ scale, locale }) => {
                localStorage.setItem("font-size", String(scale));
                localStorage.setItem("i18nextLng", locale);
                localStorage.setItem(
                    "sessions",
                    JSON.stringify(
                        ["alex", "other"].map((username) => ({
                            player: "Alex",
                            updatedAt: Date.UTC(2026, 9, 4),
                            lichess: { username, account: { id: username, username, perfs: {} } },
                        })),
                    ),
                );
            },
            { scale: corner.scale, locale: corner.locale },
        );
        const otherDatabase = {
            ...summaryLichessDatabase,
            handle: { id: { id: "summary-other" }, kind: "database" },
            filename: "other_lichess.db3",
        };
        const otherStatistics = homeSummaryPlayerStatisticsFixture("other", 3);
        await mockScenario({
            commands: {
                list_workspace_databases: {
                    result: { entries: [summaryLichessDatabase, otherDatabase], unread: [] },
                },
                get_db_info: {
                    results: [
                        summaryLichessInfo,
                        summaryLichessInfo,
                        { ...summaryLichessInfo, filename: otherDatabase.filename },
                        { ...summaryLichessInfo, filename: otherDatabase.filename },
                    ],
                    result: { ...summaryLichessInfo, filename: otherDatabase.filename },
                },
                get_players: { result: { data: [{ id: 7, name: "alex", elo: 1500 }], count: 1 } },
                get_players_game_info: {
                    outcomes: [{ result: summaryStatistics }, { result: otherStatistics }],
                    error: "Unexpected extra statistics read",
                },
            },
        });
        await page.goto("/accounts");
        const copy = corner.copy;
        for (const tab of ["Overview", "Ratings", "Openings"] as const) {
            const tabName = copy[`Home.Personal.${tab}`];
            await page.getByRole("tab", { name: tabName, exact: true }).click();
            const panel = page.getByRole("tabpanel", { name: tabName, exact: true });
            const website = panel.getByRole("textbox", {
                name: copy["Home.Accounts.Website"],
                exact: true,
            });
            const account = panel.getByRole("textbox", {
                name: copy["Home.Accounts.Account"],
                exact: true,
            });
            const time = panel.getByRole("textbox", {
                name: copy["Board.Database.TimeControl"],
                exact: true,
            });
            if (tab !== "Ratings") {
                await expect(account).toHaveCount(0);
                await expect(website).toHaveValue(copy["Home.Accounts.AllWebsites"]);
                await expectHomeSummarySelectedText(time, copy["Board.Database.Local.Result.Any"]);
                await capture(`home-summary-${corner.width}-${corner.scale}-${tab}-account-absent`);
                await website.click();
                await expectHomeSummaryDropdown(page, assertNoHorizontalOverflow);
                await page.getByRole("option", { name: "Lichess", exact: true }).click();
            }
            if (tab !== "Openings")
                await expect(
                    panel.getByText(`11 ${copy["Common.Games"]}`, { exact: true }),
                ).toBeVisible();
            await account.click();
            await expectHomeSummaryDropdown(page, assertNoHorizontalOverflow);
            await page.getByRole("option", { name: "other", exact: true }).click();
            if (tab !== "Openings")
                await expect(
                    panel.getByText(`3 ${copy["Common.Games"]}`, { exact: true }),
                ).toBeVisible();
            await account.click();
            await expectHomeSummaryDropdown(page, assertNoHorizontalOverflow);
            await page
                .getByRole("option", { name: copy["Home.Accounts.AllAccounts"], exact: true })
                .click();
            await account.click();
            await expectHomeSummaryDropdown(page, assertNoHorizontalOverflow);
            // Exercise normal keyboard selection from All accounts to alex.
            await account.press("ArrowDown");
            await account.press("Enter");
            if (tab !== "Openings")
                await expect(
                    panel.getByText(`8 ${copy["Common.Games"]}`, { exact: true }),
                ).toBeVisible();
            await expectHomeSummarySelectedText(website, "Lichess");
            await expectHomeSummarySelectedText(account, "alex");
            await capture(`home-summary-${corner.width}-${corner.scale}-${tab}-selected`);
            await website.focus();
            await page.keyboard.press("Tab");
            await expect(account).toBeFocused();
            await page.keyboard.press("Tab");
            await expect(time).toBeFocused();
            await time.press("ArrowDown");
            await expectHomeSummaryDropdown(page, assertNoHorizontalOverflow);
            // Reach the final time control with normal keyboard navigation, including
            // the option list's own vertical scroll, then restore the original selection.
            const lastOption = page.getByRole("option", {
                name: copy["TimeControl.Correspondence"],
                exact: true,
            });
            const optionCount = await page.getByRole("option").count();
            for (let step = 0; step < optionCount; step++) {
                if ((await lastOption.getAttribute("data-combobox-selected")) === "true") break;
                await time.press("ArrowDown");
            }
            await expect(lastOption).toHaveAttribute("data-combobox-selected", "true");
            await expect(lastOption).toBeInViewport({ ratio: 1 });
            await expectHomeSummaryDropdown(page, assertNoHorizontalOverflow);
            await capture(`home-summary-${corner.width}-${corner.scale}-${tab}-dropdown`);
            await time.press("Enter");
            await expect(time).toHaveValue(copy["TimeControl.Correspondence"]);
            await time.click();
            await expectHomeSummaryDropdown(page, assertNoHorizontalOverflow);
            await page
                .getByRole("option", {
                    name: copy[
                        tab === "Ratings" ? "TimeControl.Rapid" : "Board.Database.Local.Result.Any"
                    ],
                    exact: true,
                })
                .click();
            await time.blur();
            if (tab !== "Ratings") {
                await website.click();
                await expectHomeSummaryDropdown(page, assertNoHorizontalOverflow);
                await page
                    .getByRole("option", { name: copy["Home.Accounts.AllWebsites"], exact: true })
                    .click();
                await expect(account).toHaveCount(0);
                await website.click();
                await expectHomeSummaryDropdown(page, assertNoHorizontalOverflow);
                await page.getByRole("option", { name: "Lichess", exact: true }).click();
                await expect(account).toHaveValue(copy["Home.Accounts.AllAccounts"]);
            }
            await assertNoHorizontalOverflow();
        }
    });
}

for (const state of ["partial", "failed"] as const) {
    test(`accounts-puzzles-engines: home summary ${state} statistics`, async ({
        page,
        mockScenario,
        capture,
    }) => {
        await page.addInitScript(() => {
            localStorage.setItem(
                "sessions",
                JSON.stringify([
                    {
                        player: "Alex",
                        updatedAt: Date.UTC(2026, 9, 4),
                        lichess: {
                            username: "alex",
                            account: {
                                id: "alex",
                                username: "alex",
                                perfs: { rapid: { rating: 1500, games: 8, prog: 0 } },
                            },
                        },
                    },
                    {
                        player: "Alex",
                        updatedAt: Date.UTC(2026, 9, 4),
                        chessCom: {
                            username: "alex",
                            stats: {
                                chess_rapid: {
                                    last: { rating: 1500, date: 1791072000, rd: 50 },
                                    record: { win: 5, loss: 1, draw: 2 },
                                },
                            },
                        },
                    },
                ]),
            );
        });
        const statisticsRead: NonNullable<MockScenario["commands"]>[string] = {
            outcomes: [
                state === "partial"
                    ? { result: summaryStatistics }
                    : { error: "Lichess statistics unreadable" },
                { error: "Chess.com statistics unreadable" },
            ],
            error: "Statistics unreadable",
        };
        await mockScenario({
            commands: {
                list_workspace_databases: {
                    result: {
                        entries: [summaryLichessDatabase, summaryChessComDatabase],
                        unread: [],
                    },
                },
                get_db_info: {
                    // Accounts and the summary read metadata concurrently, each in database order.
                    // A different interleaving fails the failed-state test loudly because the notice
                    // would name the same database twice.
                    results: [
                        summaryLichessInfo,
                        summaryLichessInfo,
                        summaryChessComInfo,
                        summaryChessComInfo,
                    ],
                    result: summaryChessComInfo,
                },
                get_players: { result: { data: [{ id: 7, name: "alex", elo: 1500 }], count: 1 } },
                get_players_game_info: statisticsRead,
            },
        });
        await page.goto("/accounts");

        const title =
            state === "partial" ? "Statistics are incomplete" : "Could not load statistics";
        const failedDatabases =
            state === "partial" ? "Alex Chess.com" : "Alex Lichess, Alex Chess.com";
        await expect(page.getByText(title, { exact: true })).toBeVisible();
        await expect(
            page.getByText(`These databases could not be read: ${failedDatabases}`, {
                exact: true,
            }),
        ).toBeVisible();
        if (state === "partial") {
            await expect(page.getByRole("tab", { name: "Overview", exact: true })).toBeVisible();
            const total = page.getByText("8 Games", { exact: true });
            const overview = page.getByRole("tabpanel", { name: "Overview", exact: true });
            await overview.hover({ position: { x: 10, y: 10 } });
            await expect(async () => {
                await page.mouse.wheel(0, 100);
                await expect(total).toBeInViewport({ timeout: 250 });
            }).toPass({ timeout: 8000 });
            await page.mouse.move(0, 0);
            await overview.evaluate((panel) => panel.scrollTo(0, 0));
        } else {
            await expect(page.getByText("No games found", { exact: true })).toHaveCount(0);
        }
        const statisticsFiles = await page.evaluate(() =>
            window.__E2E_TAURI__
                .invocations()
                .filter(({ command }) => command === "get_players_game_info")
                .map(({ args }) => (args as { file: unknown }).file),
        );
        expect(statisticsFiles).toEqual([
            summaryLichessDatabase.handle,
            summaryChessComDatabase.handle,
        ]);
        await capture(`home-summary-${state}-statistics`);
        await expect(page).toHaveScreenshot(`home-summary-${state}-statistics.png`, {
            fullPage: true,
        });
    });
}

function seedDownloadPlayerSession(page: Page) {
    return page.addInitScript(() => {
        localStorage.setItem(
            "sessions",
            JSON.stringify([
                {
                    player: "download-player",
                    updatedAt: Date.UTC(2026, 9, 4),
                    chessCom: {
                        username: "download-player",
                        stats: {
                            chess_rapid: {
                                last: { rating: 1500, date: 1791072000, rd: 50 },
                                record: { win: 1, loss: 0, draw: 0 },
                            },
                        },
                    },
                },
            ]),
        );
    });
}

test("accounts-puzzles-engines: a linked account downloads privately and appends once with refreshed accumulated counts", async ({
    page,
    mockScenario,
}) => {
    const file = { id: { id: "account-source" }, kind: "fileWorkspace" };
    const database = { id: { id: "account-index" }, kind: "database" };
    const publication = { id: { id: "provider-batch" }, kind: "fileWorkspace" };
    const collection = {
        id: "22222222-2222-4222-8222-222222222222",
        name: "Accumulated history",
        file,
        database,
        status: "ready",
        generation: "before",
        omitted: 0,
        account: { provider: "chesscom", account: "download-player" },
        retiredDatabase: null,
        fetchSinceMs: "1791072000000",
    };
    await page.addInitScript(() => {
        localStorage.setItem(
            "file-workspace",
            JSON.stringify({ id: { id: "account-library" }, kind: "fileWorkspace" }),
        );
    });
    await seedDownloadPlayerSession(page);
    const scenario = {
        commands: {
            linked_collections_supported: { result: true },
            list_linked_collections: { result: [collection] },
            collection_for_database: { result: collection },
            list_workspace_databases: { result: { entries: [], unread: [] } },
            get_db_info: {
                result: { ...summaryDatabaseInfo, file: database, game_count: 3 },
            },
            prepare_account_collection: {
                result: {
                    collection,
                    migrationRequired: false,
                    destination: { id: "private-account-staging" },
                    pendingBatch: null,
                },
            },
            import_account_games: {
                result: {
                    id: "linked-account-import",
                    request: {
                        provider: "chesscom",
                        account: "download-player",
                        accountHandle: null,
                        destination: { id: "private-account-staging" },
                        pendingBatch: null,
                        sinceMs: Number(collection.fetchSinceMs),
                        target: { kind: "linked", collection: collection.id },
                    },
                    progressId: "linked-account-download",
                    attempt: 1,
                    importing: false,
                    outcome: { state: "succeeded", result: { collectionNotice: false } },
                    publication: { handle: publication, durability: "Durable" },
                    committedDatabase: null,
                    deletionPending: false,
                },
            },
        },
    } satisfies MockScenario;
    await mockScenario(scenario);
    await page.goto("/accounts");
    await expect(page.getByText("3 / 3", { exact: true })).toBeVisible();
    await page.evaluate(
        ({ commands, updatedInfo }) => {
            const invoke = window.__TAURI_INTERNALS__.invoke;
            window.__TAURI_INTERNALS__.invoke = async (command, args) => {
                const result = await invoke(command, args);
                if (command === "import_account_games") {
                    // Publish the committed count before the caller starts its freshness rereads.
                    window.__E2E_TAURI__.configure({
                        commands: { ...commands, get_db_info: { result: updatedInfo } },
                    });
                    window.__TAURI_INTERNALS__.invoke = invoke;
                }
                return result;
            };
        },
        {
            commands: scenario.commands,
            updatedInfo: { ...summaryDatabaseInfo, file: database, game_count: 8 },
        },
    );
    const download = page.getByRole("button", { name: "Download games", exact: true });
    await download.click();
    await expect(page.getByText("8 / 8", { exact: true })).toBeVisible();
    await expect(download).toBeEnabled();
    const calls = await page.evaluate(() => window.__E2E_TAURI__.invocations());
    expect(calls.filter(({ command }) => command === "import_account_games")).toMatchObject([
        {
            args: {
                request: {
                    provider: "chesscom",
                    account: "download-player",
                    accountHandle: null,
                    destination: { id: "private-account-staging" },
                    pendingBatch: null,
                    sinceMs: Number(collection.fetchSinceMs),
                    target: { kind: "linked", collection: collection.id },
                },
            },
        },
    ]);
    expect(
        calls.filter(({ command }) =>
            [
                "append_collection_games",
                "download_chess_com_games",
                "convert_pgn",
                "create_workspace_database",
                "delete_empty_games",
            ].includes(command),
        ),
    ).toEqual([]);
});

test("accounts-puzzles-engines: warns when a downloaded game file's save is not confirmed", async ({
    page,
    mockScenario,
    capture,
}) => {
    const publicationHandle = { id: { id: "uncertain-chesscom-download" }, kind: "fileWorkspace" };
    const databaseHandle = { id: { id: "chesscom-import" }, kind: "database" };
    await seedDownloadPlayerSession(page);
    await mockScenario({
        commands: {
            issue_download_destination: { result: { id: "download-destination" } },
            create_workspace_database: { result: databaseHandle },
            import_account_games: {
                result: {
                    id: "uncertain-import",
                    request: {
                        provider: "chesscom",
                        account: "download-player",
                        accountHandle: null,
                        destination: { id: "download-destination" },
                        pendingBatch: null,
                        sinceMs: null,
                        target: {
                            kind: "unlinked",
                            database: databaseHandle,
                            title: "download-player Chess.com",
                        },
                    },
                    progressId: "uncertain-ticket",
                    attempt: 1,
                    importing: false,
                    outcome: { state: "succeeded", result: { collectionNotice: false } },
                    publication: {
                        handle: publicationHandle,
                        durability: { DurabilityUncertain: "DownloadTargetReplacement" },
                    },
                    committedDatabase: databaseHandle,
                    deletionPending: false,
                },
            },
        },
    });
    await page.goto("/accounts");
    const download = page.getByRole("button", { name: "Download games", exact: true });
    await download.click();

    const warning = page.getByText(
        "The games were downloaded, but the save could not be fully confirmed. Do not retry.",
        { exact: true },
    );
    await expect(warning).toBeVisible();
    await expect(download).toBeEnabled();
    const notification = page.locator(".mantine-Notification-root");
    await expect(notification).toHaveCount(1);
    await expectNotificationSettled(notification);

    const invocations = await page.evaluate(() => window.__E2E_TAURI__.invocations());
    expect(invocations.filter(({ command }) => command === "import_account_games")).toMatchObject([
        {
            args: {
                request: {
                    provider: "chesscom",
                    account: "download-player",
                    destination: { id: "download-destination" },
                    pendingBatch: null,
                    sinceMs: null,
                    target: {
                        kind: "unlinked",
                        database: databaseHandle,
                        title: "download-player Chess.com",
                    },
                },
            },
        },
    ]);
    expect(
        invocations.filter(({ command }) =>
            ["download_chess_com_games", "convert_pgn", "delete_empty_games"].includes(command),
        ),
    ).toEqual([]);
    await capture("account-download-durability-uncertain");
    await expect(page).toHaveScreenshot("account-download-durability-uncertain.png", {
        fullPage: true,
    });
});

const retainedAccountRequest = {
    provider: "chesscom",
    account: "download-player",
    accountHandle: null,
    destination: { id: "retained-destination" },
    pendingBatch: null,
    sinceMs: null,
    target: {
        kind: "unlinked" as const,
        database: { id: { id: "retained-database" }, kind: "database" as const },
        title: "download-player Chess.com",
    },
};

async function openDownloadPlayerAccount(
    page: Page,
    mockScenario: (scenario: MockScenario) => Promise<void>,
) {
    await seedDownloadPlayerSession(page);
    await mockScenario({ commands: {} });
    await page.goto("/accounts");
}

test("accounts-puzzles-engines: a retained running completion keeps download unavailable after reload", async ({
    page,
    mockScenario,
}) => {
    await openDownloadPlayerAccount(page, mockScenario);
    const download = page.getByRole("button", { name: "Download games", exact: true });
    await expect(download).toBeEnabled();
    await page.evaluate((request) => {
        window.__E2E_TAURI__.retainAccountCompletion({
            id: "retained-running",
            request,
            progressId: "retained-ticket",
            attempt: 1,
            importing: false,
            outcome: { state: "running" },
            publication: null,
            committedDatabase: null,
            deletionPending: false,
        });
    }, retainedAccountRequest);
    await preserveStorageForReload(page);
    await expect(download).toBeDisabled();
    const calls = await page.evaluate(() => window.__E2E_TAURI__.invocations());
    expect(calls.filter(({ command }) => command === "import_account_games")).toEqual([]);
});

test("accounts-puzzles-engines: a retained uncertain failure shows the do-not-retry notice after reload", async ({
    page,
    mockScenario,
}) => {
    await openDownloadPlayerAccount(page, mockScenario);
    const download = page.getByRole("button", { name: "Download games", exact: true });
    await expect(download).toBeEnabled();
    await page.evaluate((request) => {
        window.__E2E_TAURI__.retainAccountCompletion({
            id: "retained-uncertain",
            request,
            progressId: "retained-ticket",
            attempt: 1,
            importing: false,
            outcome: {
                state: "failed",
                result: {
                    tag: "backend-error",
                    category: "database",
                    message: "import failed",
                },
            },
            publication: {
                handle: { id: { id: "retained-publication" }, kind: "fileWorkspace" },
                durability: { DurabilityUncertain: "DownloadTargetReplacement" },
            },
            committedDatabase: null,
            deletionPending: false,
        });
    }, retainedAccountRequest);
    await preserveStorageForReload(page);
    await expect(
        page.getByText(
            "The games were downloaded, but the save could not be fully confirmed. Do not retry.",
            { exact: true },
        ),
    ).toBeVisible();
    await expect(page.getByText("import failed", { exact: true })).toBeVisible();
    await expect(download).toBeEnabled();
    const calls = await page.evaluate(() => window.__E2E_TAURI__.invocations());
    expect(calls.filter(({ command }) => command === "import_account_games")).toEqual([]);
});

async function seedUnerasableLegacySessions(page: Page, tokens: string[]) {
    const storedSessions = JSON.stringify(
        tokens.map((accessToken, index) => ({
            updatedAt: 1,
            player: `legacy-player-${index}`,
            lichess: {
                username: `legacy-player-${index}`,
                account: { id: `legacy-player-${index}`, username: `legacy-player-${index}` },
                accessToken,
            },
        })),
    );
    await page.addInitScript((sessions) => {
        const originalSetItem = Storage.prototype.setItem;
        const originalRemoveItem = Storage.prototype.removeItem;
        originalSetItem.call(localStorage, "sessions", sessions);
        // Refuse both erase paths without blocking the fixture's keys or i18next caching.
        Storage.prototype.setItem = function (key, value) {
            if (key === "sessions") throw new DOMException("refused", "QuotaExceededError");
            return originalSetItem.call(this, key, value);
        };
        Storage.prototype.removeItem = function (key) {
            if (key === "sessions") throw new DOMException("refused", "QuotaExceededError");
            return originalRemoveItem.call(this, key);
        };
    }, storedSessions);
    return storedSessions;
}

test("accounts-puzzles-engines: retains unsaved public cards and retries only the latest list without reload", async ({
    page,
    mockScenario,
    capture,
}) => {
    const token = "lip_e2e-public-retention-sentinel";
    const diagnostics: string[] = [];
    page.on("console", (message) => diagnostics.push(message.text()));
    page.on("pageerror", (error) => diagnostics.push(error.message));
    await page.addInitScript((token) => {
        // On the recovery reload the real saved record remains. Do not reseed it or the fault.
        if (localStorage.getItem("sessions") !== null) return;
        localStorage.setItem(
            "sessions",
            JSON.stringify([
                {
                    player: "Saved player",
                    updatedAt: Date.UTC(2026, 9, 4),
                    lichess: {
                        username: "retained-player",
                        handle: "old-handle",
                        accessToken: token,
                        account: {
                            id: "retained-player",
                            username: "retained-player",
                            perfs: { rapid: { rating: 1500, games: 8, prog: 0 } },
                        },
                    },
                },
                {
                    player: "Remove me",
                    updatedAt: Date.UTC(2026, 9, 4),
                    chessCom: { username: "retained-chesscom", stats: {} },
                },
            ]),
        );
        const original = Storage.prototype.setItem;
        Object.assign(window, {
            __restoreSessionWrites: () => {
                Storage.prototype.setItem = original;
            },
        });
        // Removal remains available so startup can synchronously erase the legacy bearer.
        Storage.prototype.setItem = function (key, value) {
            if (key === "sessions") throw new DOMException("refused", "QuotaExceededError");
            return original.call(this, key, value);
        };
    }, token);
    await mockScenario({
        commands: {
            migrate_legacy_lichess_token: {
                result: {
                    account: { username: "retained-player", handle: "migrated-handle" },
                    durability_uncertain: false,
                },
            },
            list_lichess_accounts: {
                result: [{ username: "retained-player", handle: "current-handle" }],
            },
        },
    });
    await page.goto("/accounts");
    const notice = page.getByRole("alert").filter({ hasText: "Accounts could not be saved" });
    await expect(notice).toContainText(
        "Your accounts are available during this session. Unsaved account changes may be lost when you close or reload ChessRiddle Studio.",
    );
    await expect(page.getByText("Saved player", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Remove me", { exact: true }).first()).toBeVisible();
    await expect(
        page.locator(".mantine-Card-root").filter({ hasText: "retained-player" }),
    ).toBeVisible();
    await expect(
        page.locator(".mantine-Card-root").filter({ hasText: "retained-chesscom" }),
    ).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("sessions"))).toBeNull();
    await page.getByRole("button", { name: "Edit player name", exact: true }).first().click();
    await page.locator("input:visible").first().fill("Latest alias");
    await page.getByRole("button", { name: "Save player name", exact: true }).click();
    await page
        .getByText("Remove me", { exact: true })
        .locator("..")
        .getByRole("button", { name: "Remove account", exact: true })
        .click();
    await expect(page.getByText("Latest alias", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Remove me", { exact: true })).toHaveCount(0);
    const beforeRetry = await page.evaluate(() =>
        window.__E2E_TAURI__
            .invocations()
            .filter(({ command }) =>
                [
                    "list_lichess_accounts",
                    "migrate_legacy_lichess_token",
                    "revoke_legacy_lichess_token",
                ].includes(command),
            ),
    );
    const retry = notice.getByRole("button", { name: "Try saving again", exact: true });
    const title = notice.getByText("Accounts could not be saved", { exact: true });
    const explanation = notice.getByText(
        "Your accounts are available during this session. Unsaved account changes may be lost when you close or reload ChessRiddle Studio.",
        { exact: true },
    );
    async function expectNoticeReachable(width: number, height: number) {
        expect(page.viewportSize()).toEqual({ width, height });
        await expect(page.locator("html")).toHaveCSS("font-size", "32px");
        await expect(notice).toHaveCSS("position", "fixed");
        const geometry = await notice.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return {
                viewport: { width: window.innerWidth, height: window.innerHeight },
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
                clientHeight: element.clientHeight,
                scrollHeight: element.scrollHeight,
            };
        });
        expect(geometry.viewport).toEqual({ width, height });
        expect(geometry.left).toBeGreaterThan(0);
        expect(geometry.top).toBeGreaterThan(0);
        expect(geometry.right).toBeLessThan(width);
        expect(geometry.bottom).toBeLessThan(height);
        await expect(notice).toHaveCSS(
            "background-color",
            await page.locator("body").evaluate((body) => getComputedStyle(body).backgroundColor),
        );
        expect(geometry.scrollHeight).toBe(geometry.clientHeight);
        await expect(title).toBeInViewport({ ratio: 1 });
        await expect(retry).toBeInViewport({ ratio: 1 });
        await assertNothingClipped(notice, { mode: "reachable" });
        const titleBeforeScroll = await title.boundingBox();
        const retryBeforeScroll = await retry.boundingBox();
        const textGeometry = await explanation.evaluate((element) => ({
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
            horizontalOverflow: element.scrollWidth - element.clientWidth,
        }));
        expect(textGeometry.clientHeight).toBeGreaterThan(0);
        expect(textGeometry.horizontalOverflow).toBeLessThanOrEqual(1);
        await explanation.focus();
        await explanation.press("Control+End");
        await expect
            .poll(() => explanation.evaluate((element) => element.scrollTop))
            .toBe(textGeometry.scrollHeight - textGeometry.clientHeight);
        await expect(title).toBeInViewport({ ratio: 1 });
        await expect(retry).toBeInViewport({ ratio: 1 });
        expect(await title.boundingBox()).toEqual(titleBeforeScroll);
        expect(await retry.boundingBox()).toEqual(retryBeforeScroll);
        await assertNothingClipped(notice, { mode: "reachable" });
        await explanation.press("Control+Home");
        await expect.poll(() => explanation.evaluate((element) => element.scrollTop)).toBe(0);
        await retry.scrollIntoViewIfNeeded();
        await expect(title).toBeInViewport({ ratio: 1 });
        await expect(retry).toBeInViewport({ ratio: 1 });
        expect(
            await retry.evaluate((button) => {
                const rect = button.getBoundingClientRect();
                return button.contains(
                    document.elementFromPoint(
                        rect.left + rect.width / 2,
                        rect.top + rect.height / 2,
                    ),
                );
            }),
        ).toBe(true);
        console.log(
            `Session persistence notice ${width}x${height}: ${JSON.stringify({
                ...geometry,
                title: titleBeforeScroll,
                retry: retryBeforeScroll,
                explanation: textGeometry,
            })}`,
        );
    }
    await expectNoticeReachable(1440, 900);
    await retry.click();
    await expect(notice).toBeVisible();
    await expect(title).toBeInViewport({ ratio: 1 });
    await expect(retry).toBeInViewport({ ratio: 1 });
    await expect(page.getByText("Latest alias", { exact: true }).first()).toBeVisible();
    await expect(
        page.locator(".mantine-Card-root").filter({ hasText: "retained-chesscom" }),
    ).toHaveCount(0);
    await capture("session-persistence-unsaved-desktop");
    await expect(page).toHaveScreenshot("session-persistence-unsaved-desktop.png", {
        fullPage: true,
    });

    // Route changes keep the document owner and warning mounted without another bootstrap.
    await page.locator('a[href="/engines"]').click();
    await expect(notice).toBeVisible();
    await page.setViewportSize({ width: 320, height: 720 });
    await expect(page.locator("html")).toHaveCSS("font-size", "32px");
    await assertNothingClipped(notice, { mode: "reachable" });
    await expectNoticeReachable(320, 720);
    await retry.click();
    await expect(notice).toBeVisible();
    await expect(title).toBeInViewport({ ratio: 1 });
    await expect(retry).toBeInViewport({ ratio: 1 });
    await capture("session-persistence-unsaved-320px-200pct");
    await expect(page).toHaveScreenshot("session-persistence-unsaved-320px-200pct.png", {
        fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('a[href="/accounts"]').click();
    await expect(page.getByText("Latest alias", { exact: true }).first()).toBeVisible();
    await page.evaluate(() =>
        (window as typeof window & { __restoreSessionWrites: () => void }).__restoreSessionWrites(),
    );
    await notice.getByRole("button", { name: "Try saving again", exact: true }).click();
    await expect(notice).toHaveCount(0);
    expect(
        await page.evaluate(() =>
            window.__E2E_TAURI__
                .invocations()
                .filter(({ command }) =>
                    [
                        "list_lichess_accounts",
                        "migrate_legacy_lichess_token",
                        "revoke_legacy_lichess_token",
                    ].includes(command),
                ),
        ),
    ).toEqual(beforeRetry);
    const encoded = await page.evaluate(() => localStorage.getItem("sessions"));
    const saved = deserializeStorageValue(encoded!);
    expect(saved).toMatchObject([
        {
            player: "Latest alias",
            lichess: { username: "retained-player", handle: "current-handle" },
        },
    ]);
    expect(saved).toHaveLength(1);
    expect(JSON.stringify(saved)).not.toMatch(/accessToken|lip_e2e-public-retention-sentinel/);
    expect(encoded).not.toContain(token);
    await expect(page.locator("body")).not.toContainText(token);
    expect(diagnostics.join("\n")).not.toContain(token);
    await preserveStorageForReload(page);
    await expect(page.getByText("Latest alias", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Saved player", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Remove me", { exact: true })).toHaveCount(0);
    await expect(notice).toHaveCount(0);
    expect(
        deserializeStorageValue(
            (await page.evaluate(() => localStorage.getItem("sessions"))) ?? "",
        ),
    ).toEqual(saved);
    await expect(page.locator("body")).not.toContainText(token);
    expect(diagnostics.join("\n")).not.toContain(token);
});

test("accounts-puzzles-engines: workspace-read-refusal preserves saved bytes and offers startup retry", async ({
    page,
    mockScenario,
    capture,
}) => {
    const tabId = "a4d280db-5d3b-4806-807d-7d3637c318a4";
    const storedWorkspace = serializeStorageValue({
        version: 1,
        tabs: [
            { name: "Saved workspace", value: tabId, type: "new", gameOrigin: { kind: "none" } },
        ],
        activeTab: tabId,
    });
    await page.addInitScript((workspace) => {
        localStorage.setItem("i18nextLng", "en-US");
        sessionStorage.setItem("workspace", workspace);
        const originalGetItem = Storage.prototype.getItem;
        Storage.prototype.getItem = function (key) {
            if (this === sessionStorage && key === "workspace")
                throw new DOMException("workspace read refused", "SecurityError");
            return originalGetItem.call(this, key);
        };
    }, storedWorkspace);
    await mockScenario({ commands: {} });
    await page.goto("/");

    await expect(
        page.getByRole("heading", {
            name: "ChessRiddle Studio could not start",
            level: 1,
            exact: true,
        }),
    ).toBeVisible();
    await expect(
        page.getByText(
            "ChessRiddle Studio could not read its saved workspace and left it unchanged. Try again to read it once more.",
            { exact: true },
        ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await expect(page.getByRole("link")).toHaveCount(0);
    // Named storage access observes the bytes without calling the refused getItem method.
    expect(await page.evaluate(() => sessionStorage["workspace"])).toBe(storedWorkspace);
    const invocations = await page.evaluate(() => window.__E2E_TAURI__.invocations());
    expect(invocations.some(({ command }) => command === "close_splashscreen")).toBe(true);
    await capture("workspace-read-refusal");
    await expect(page).toHaveScreenshot("workspace-read-refusal.png", { fullPage: true });
});

test("accounts-puzzles-engines: refuses startup when legacy sign-in storage cannot be erased", async ({
    page,
    mockScenario,
    capture,
}) => {
    const token = "lip_e2e-legacy-token";
    const storedSessions = await seedUnerasableLegacySessions(page, [token]);
    await mockScenario({
        commands: { revoke_legacy_lichess_token: { result: "already_invalid" } },
    });
    await page.goto("/");

    await expect(
        page.getByRole("heading", {
            name: "ChessRiddle Studio could not start",
            level: 1,
            exact: true,
        }),
    ).toBeVisible();
    await expect(
        page.getByText(
            "A saved Lichess sign-in could not be removed from local storage. This sign-in no longer works at Lichess. You can sign in again once ChessRiddle Studio starts. Try again to retry removing the saved sign-in.",
            { exact: true },
        ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await expect(page.getByRole("link")).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("sessions"))).toBe(storedSessions);

    const invocations = await page.evaluate(() => window.__E2E_TAURI__.invocations());
    expect(invocations.some(({ command }) => command === "close_splashscreen")).toBe(true);
    expect(invocations.filter(({ command }) => command === "revoke_legacy_lichess_token")).toEqual([
        { command: "revoke_legacy_lichess_token", args: { token } },
    ]);
    expect(
        invocations.filter(({ command }) =>
            ["migrate_legacy_lichess_token", "list_lichess_accounts"].includes(command),
        ),
    ).toEqual([]);
    await capture("startup-storage-failure-revoked");
    await expect(page).toHaveScreenshot("startup-storage-failure-revoked.png", { fullPage: true });
});

test("accounts-puzzles-engines: startup names every unconfirmed revocation reason", async ({
    page,
    mockScenario,
    capture,
}) => {
    const tokens = ["lip_e2e-offline", "lip_e2e-limited", "lip_e2e-rejected", "lip_e2e-ipc"];
    const storedSessions = await seedUnerasableLegacySessions(page, tokens);
    await mockScenario({
        commands: {
            revoke_legacy_lichess_token: {
                outcomes: [
                    { result: "unreachable" },
                    { result: "rate_limited" },
                    { result: "rejected" },
                    { error: "lip_e2e-ipc" },
                ],
            },
        },
    });
    await page.goto("/");
    await expect(
        page.getByRole("heading", { name: "ChessRiddle Studio could not start", exact: true }),
    ).toBeVisible();
    for (const reason of [
        "Lichess could not be reached.",
        "Lichess is limiting requests.",
        "Lichess rejected the request or returned an unexpected response.",
        "The revocation result could not be confirmed.",
    ]) {
        await expect(page.getByText(reason, { exact: true })).toBeVisible();
    }
    await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation")).toHaveCount(0);
    for (const sensitive of [...tokens, "legacy-player"])
        await expect(page.locator("body")).not.toContainText(sensitive);
    expect(await page.evaluate(() => localStorage.getItem("sessions"))).toBe(storedSessions);
    const invocations = await page.evaluate(() => window.__E2E_TAURI__.invocations());
    expect(invocations.filter(({ command }) => command === "revoke_legacy_lichess_token")).toEqual(
        tokens.map((token) => ({ command: "revoke_legacy_lichess_token", args: { token } })),
    );
    expect(
        invocations.filter(({ command }) =>
            ["migrate_legacy_lichess_token", "list_lichess_accounts"].includes(command),
        ),
    ).toEqual([]);
    await capture("startup-storage-failure-unconfirmed");
    await expect(page).toHaveScreenshot("startup-storage-failure-unconfirmed.png", {
        fullPage: true,
    });
});

for (const [outcome, reason] of [
    ["unreachable", "Lichess could not be reached."],
    ["rate_limited", "Lichess is limiting requests."],
    ["rejected", "Lichess rejected the request or returned an unexpected response."],
] as const) {
    test(`accounts-puzzles-engines: local logout warns about ${outcome}`, async ({
        page,
        mockScenario,
        capture,
    }) => {
        await page.addInitScript(() =>
            localStorage.setItem(
                "sessions",
                JSON.stringify([
                    {
                        updatedAt: 1,
                        lichess: {
                            username: "logout-player",
                            handle: "logout-handle",
                            account: { id: "logout-player", username: "logout-player" },
                        },
                    },
                ]),
            ),
        );
        await mockScenario({
            commands: {
                list_lichess_accounts: {
                    result: [{ username: "logout-player", handle: "logout-handle" }],
                },
                remove_lichess_account: {
                    result: {
                        state: "removed",
                        revocation_pending: true,
                        revocation_outcome: outcome,
                        durability_uncertain: true,
                    },
                },
            },
        });
        await page.goto("/accounts");
        await page
            .locator(".mantine-Card-root")
            .filter({ hasText: "logout-player" })
            .getByRole("button", { name: "Remove account", exact: true })
            .click();
        await expect(
            page.getByText(
                `Local logout completed. ${reason} Revocation at Lichess is unconfirmed.`,
                { exact: true },
            ),
        ).toBeVisible();
        await expect(
            page.getByText(
                "The account was removed, but the save could not be fully confirmed. Do not retry.",
                { exact: true },
            ),
        ).toBeVisible();
        expect(
            decodeCompressedOrJson(await page.evaluate(() => localStorage.getItem("sessions"))),
        ).toEqual([]);
        const invocations = await page.evaluate(() => window.__E2E_TAURI__.invocations());
        expect(invocations.filter(({ command }) => command === "remove_lichess_account")).toEqual([
            { command: "remove_lichess_account", args: { handle: "logout-handle" } },
        ]);
        const notifications = page.locator(".mantine-Notification-root");
        await expect(notifications).toHaveCount(2);
        for (const notification of await notifications.all())
            await expectNotificationSettled(notification);
        await capture(`account-logout-${outcome}`);
        await expect(page).toHaveScreenshot(`account-logout-${outcome}.png`, { fullPage: true });
    });
}

test("accounts-puzzles-engines: local settings and catalog upgrade modal", async ({
    page,
    mockScenario,
    capture,
}) => {
    await page.addInitScript(() => {
        localStorage.setItem(
            "engines",
            JSON.stringify([
                {
                    type: "local",
                    id: "stockfish-entry",
                    name: "Stockfish 18",
                    version: "18",
                    handle: { id: { id: "stockfish-18" }, kind: "engine" },
                    filename: "Stockfish 18",
                    elo: 3650,
                    loaded: true,
                    go: { t: "Infinite" },
                    settings: [
                        { type: "string", name: "Threads", value: "20" },
                        { type: "string", name: "Hash", value: "8192" },
                        { type: "string", name: "MultiPV", value: "4" },
                    ],
                },
            ]),
        );
        // This new settings proof uses the normal product font scale so all actions fit.
        localStorage.setItem("font-size", "100");
    });
    await mockScenario({
        commands: {
            is_bmi2_compatible: { result: false },
            file_exists: { result: true },
            verify_signed_bytes: { result: null },
            get_progress: { result: null },
            get_engine_config: {
                result: {
                    name: "Stockfish 18",
                    options: [
                        { type: "spin", value: { name: "Threads", default: 1, min: 1, max: 1024 } },
                        {
                            type: "spin",
                            value: { name: "Hash", default: 16, min: 1, max: 33554432 },
                        },
                        { type: "spin", value: { name: "MultiPV", default: 1, min: 1, max: 256 } },
                    ],
                },
            },
        },
    });
    await page.goto("/engines?selected=0");
    const upgrade = page.getByRole("button", { name: "Upgrade from catalog", exact: true });
    await expect(upgrade).toBeVisible();
    await upgrade.scrollIntoViewIfNeeded();
    await capture("engine-settings-upgrade");
    await expect(page).toHaveScreenshot("engine-settings-upgrade.png", { fullPage: true });
    await upgrade.click();
    const dialog = page.getByRole("dialog", { name: "Upgrade from catalog", exact: true });
    await expect(
        dialog.getByRole("button", { name: "Install", exact: true }).first(),
    ).toBeVisible();
    await capture("engine-upgrade-modal");
    await expect(dialog).toHaveScreenshot("engine-upgrade-modal.png");
    await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
    await expect(dialog).not.toBeVisible();

    await page.evaluate(() =>
        window.__E2E_TAURI__.configure({
            commands: {
                file_exists: { result: true },
                get_progress: { result: null },
                reconcile_engine_attachments: { result: null, delay: 700 },
                retire_engine: { result: null },
            },
        }),
    );
    const name = page.getByRole("textbox", { name: "Name", exact: true });
    const card = page.locator('button[aria-pressed="true"]').locator("p").first();
    const before = await page.evaluate(() => localStorage.getItem("engines"));
    await name.fill("Saved publication");
    await expect(name).toHaveValue("Saved publication");
    await expect(card).toBeVisible();
    await expect(card).toHaveText("Stockfish 18");
    expect(await page.evaluate(() => localStorage.getItem("engines"))).toBe(before);
    await expect(page.getByText(/Unexpected Tauri IPC command/)).toHaveCount(0);
    await capture("engine-publication-pending-draft");
    await expect(card).toHaveText("Saved publication");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("engines"))).not.toBe(before);

    await page.evaluate(() => {
        const original = Storage.prototype.setItem;
        Object.assign(window, {
            __engineStorageRefusals: 0,
            __restoreEngineStorage: () => {
                Storage.prototype.setItem = original;
            },
        });
        Storage.prototype.setItem = function (key, value) {
            if (key === "engines") {
                const state = window as typeof window & { __engineStorageRefusals: number };
                state.__engineStorageRefusals++;
                throw new DOMException("Engine storage refused", "QuotaExceededError");
            }
            original.call(this, key, value);
        };
    });
    const savedBytes = await page.evaluate(() => localStorage.getItem("engines"));
    await name.fill("Refused publication");
    await expect(name).toHaveValue("Refused publication");
    await expect(name).toHaveValue("Saved publication");
    await expect(card).toHaveText("Saved publication");
    await expect(page.getByText(/The engine list could not be saved/).first()).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("engines"))).toBe(savedBytes);
    await page.getByRole("button", { name: "Duplicate", exact: true }).click();
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    (window as typeof window & { __engineStorageRefusals: number })
                        .__engineStorageRefusals,
            ),
        )
        .toBe(2);
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(
        "Saved publication",
    );
    await expect(page.getByText("Saved publication (Copy)", { exact: true })).toHaveCount(0);
    await expect(card).toHaveText("Saved publication");
    await capture("engine-publication-refused-edit-duplicate");
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    const removal = page.getByRole("dialog");
    await removal.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(page.getByText("Saved publication", { exact: true })).toHaveCount(0);
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    window.__E2E_TAURI__
                        .invocations()
                        .filter((call) => call.command === "retire_engine").length,
            ),
        )
        .toBe(1);
    expect(await page.evaluate(() => localStorage.getItem("engines"))).toBe(savedBytes);
    await capture("engine-publication-refused-removal");
    await page.evaluate(() => {
        (window as typeof window & { __restoreEngineStorage: () => void }).__restoreEngineStorage();
    });
});

test("accounts-puzzles-engines: add engine download catalog", async ({
    page,
    mockScenario,
    capture,
    assertNoHorizontalOverflow,
}) => {
    await page.addInitScript(() => {
        localStorage.setItem("font-size", "100");
    });
    // The engine catalog is bundled; mock its native signature check, the CPU-capability query and idle progress.
    await mockScenario({
        commands: {
            is_bmi2_compatible: { result: false },
            verify_signed_bytes: { result: null },
            get_progress: { result: null },
        },
    });
    await page.goto("/engines");
    await page.getByRole("button", { name: "Add New", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add Engine", exact: true });
    await expect(dialog.getByRole("tab", { name: "Download", exact: true })).toHaveAttribute(
        "aria-selected",
        "true",
    );
    await expect(
        dialog.getByRole("button", { name: "Install", exact: true }).first(),
    ).toBeVisible();
    await expect(dialog).toHaveScreenshot("engine-add-catalog.png");

    const transferCommands = {
        is_bmi2_compatible: { result: false },
        verify_signed_bytes: { result: null },
        get_progress: { result: null },
        prepare_download: { result: "engine-download-ticket" },
        release_download: { result: null },
        get_engine_workspace: { result: { id: { id: "engine-root" }, kind: "engineRoot" } },
        install_engine_workflow: {
            delay: 5000,
            error: {
                tag: "backend-error",
                category: "io",
                message: "Engine configuration failed after transfer",
            },
        },
        clear_progress: {
            error: {
                tag: "backend-error",
                category: "io",
                message: "Progress clear refused",
            },
        },
    } satisfies NonNullable<MockScenario["commands"]>;
    await page.evaluate(
        (commands) => window.__E2E_TAURI__.configure({ commands }),
        transferCommands,
    );
    await dialog.getByRole("button", { name: "Install", exact: true }).first().click();
    await expect
        .poll(() =>
            page.evaluate(() =>
                window.__E2E_TAURI__
                    .invocations()
                    .some(({ command }) => command === "install_engine_workflow"),
            ),
        )
        .toBe(true);
    const progressId = await page.evaluate((commands) => {
        const call = window.__E2E_TAURI__
            .invocations()
            .find(({ command }) => command === "install_engine_workflow")!;
        const { progressId: id } = (call.args as { request: { progressId: string } }).request;
        const succeeded = {
            id,
            generation: "7",
            progress: 100,
            finished: true,
            state: "succeeded",
        };
        window.__E2E_TAURI__.configure({
            commands: { ...commands, get_progress: { result: succeeded } },
        });
        window.__E2E_TAURI__.emit("progress-event", { ...succeeded, cleared: false });
        return id;
    }, transferCommands);
    const finalizing = dialog.getByRole("button", { name: /Extracting/ });
    await expect(finalizing).toBeDisabled();
    await expect(finalizing.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    await capture("engine-add-active-finalization");
    await assertCatalogActionReachable(
        finalizing,
        dialog.getByRole("button", { name: "Cancel", exact: true }),
    );
    await assertNoHorizontalOverflow();
    await expect(
        page.getByText("Engine configuration failed after transfer", { exact: true }),
    ).toBeVisible();
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    window.__E2E_TAURI__
                        .invocations()
                        .filter(({ command }) => command === "clear_progress").length,
            ),
        )
        .toBe(1);
    const install = dialog.getByRole("button", { name: "Install", exact: true }).first();
    await expect(install).toBeEnabled();
    await expect(install.getByRole("progressbar")).toHaveCount(0);
    await expect(dialog.getByRole("progressbar")).toHaveCount(0);
    await capture("engine-add-failed-cleanup-idle");
    const readsBeforeReopen = await page.evaluate(
        (id) =>
            window.__E2E_TAURI__
                .invocations()
                .filter(
                    (call) =>
                        call.command === "get_progress" && (call.args as { id: string }).id === id,
                ).length,
        progressId,
    );
    await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.getByRole("button", { name: "Add New", exact: true }).click();
    await expect
        .poll(() =>
            page.evaluate(
                (id) =>
                    window.__E2E_TAURI__
                        .invocations()
                        .filter(
                            (call) =>
                                call.command === "get_progress" &&
                                (call.args as { id: string }).id === id,
                        ).length,
                progressId,
            ),
        )
        .toBeGreaterThan(readsBeforeReopen);
    await expect(dialog).toHaveCSS("opacity", "1");
    await expect(install).toBeEnabled();
    await expect(install.getByRole("progressbar")).toHaveCount(0);
    await expect(dialog.getByRole("progressbar")).toHaveCount(0);
    await capture("engine-add-reopened-idle");
});

test("accounts-puzzles-engines: retained failed engine download has no partial fill", async ({
    page,
    mockScenario,
}) => {
    await mockScenario({
        commands: {
            is_bmi2_compatible: { result: false },
            verify_signed_bytes: { result: null },
            get_progress: { result: null },
        },
    });
    await page.goto("/engines");
    await page.getByRole("button", { name: "Add New", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add Engine", exact: true });
    const install = dialog.getByRole("button", { name: "Install", exact: true }).first();
    await expect(install).toBeEnabled();
    await expect
        .poll(() =>
            page.evaluate(() =>
                window.__E2E_TAURI__
                    .invocations()
                    .some(({ command }) => command === "get_progress"),
            ),
        )
        .toBe(true);
    await page.evaluate(() => {
        const call = window.__E2E_TAURI__
            .invocations()
            .find(({ command }) => command === "get_progress")!;
        const { id } = call.args as { id: string };
        window.__E2E_TAURI__.emit("progress-event", {
            id,
            generation: "7",
            state: "running",
            progress: 37,
            finished: false,
            cleared: false,
        });
    });
    await expect(dialog.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "37");
    await page.evaluate(() => {
        const call = window.__E2E_TAURI__
            .invocations()
            .find(({ command }) => command === "get_progress")!;
        const { id } = call.args as { id: string };
        window.__E2E_TAURI__.emit("progress-event", {
            id,
            generation: "7",
            state: "failed",
            progress: 37,
            finished: true,
            cleared: false,
        });
    });
    await expect(install).toBeEnabled();
    await expect(install.getByRole("progressbar")).toHaveCount(0);
    await expect(dialog.getByRole("progressbar")).toHaveCount(0);
});

for (const kind of ["add", "upgrade"] as const) {
    test(`accounts-puzzles-engines: ${kind} completion recovers after a real page reload without reseeding`, async ({
        page,
        mockScenario,
        capture,
    }) => {
        const old = {
            type: "local",
            id: "reload-target",
            legacyAssessment: null,
            name: "Original Engine",
            version: "1",
            handle: { id: { id: "original-binary" }, kind: "engine" },
            filename: "old",
            settings: [],
        };
        const seed = {
            engines: serializeStorageValue(kind === "upgrade" ? [old] : []),
            player: serializeStorageValue({
                type: "engine",
                engine: old,
                go: { t: "Depth", c: 12 },
            }),
        };
        await page.addInitScript(
            ({ kind, seed }) => {
                if (sessionStorage.getItem("__E2E_RELOAD_ENGINE_SEEDED__")) return;
                sessionStorage.setItem("__E2E_RELOAD_ENGINE_SEEDED__", "1");
                localStorage.setItem("engines", seed.engines);
                localStorage.setItem("font-size", "100");
                if (kind === "upgrade")
                    for (const key of ["game-player1-settings", "game-player2-settings"])
                        localStorage.setItem(key, seed.player);
            },
            { kind, seed },
        );
        await mockScenario({
            commands: {
                is_bmi2_compatible: { result: false },
                verify_signed_bytes: { result: null },
                get_progress: { result: null },
                clear_progress: { result: "1" },
                file_exists: { result: true },
                prepare_download: { result: "reload-engine-ticket" },
                release_download: { result: null },
                get_engine_workspace: { result: { id: { id: "engine-root" }, kind: "engineRoot" } },
                install_engine_workflow: {
                    engineInstall: true,
                    result: {
                        handle: { id: { id: "recovered-binary" }, kind: "engine" },
                        filename: "new",
                        config: { name: "Recovered Engine", options: [] },
                    },
                },
            },
        });
        await page.goto(kind === "upgrade" ? "/engines?selected=0" : "/engines");
        await page
            .getByRole("button", {
                name: kind === "upgrade" ? "Upgrade from catalog" : "Add New",
                exact: true,
            })
            .click();
        const dialog = page.getByRole("dialog", {
            name: kind === "upgrade" ? "Upgrade from catalog" : "Add Engine",
            exact: true,
        });
        await expect(
            dialog.getByRole("button", { name: "Install", exact: true }).first(),
        ).toBeVisible();
        await page.evaluate(
            (key) => {
                const original = Storage.prototype.setItem;
                Storage.prototype.setItem = function (name, value) {
                    if (name === key)
                        throw new DOMException("completion owner refused", "QuotaExceededError");
                    original.call(this, name, value);
                };
            },
            kind === "upgrade" ? "game-player2-settings" : "engines",
        );
        await dialog.getByRole("button", { name: "Install", exact: true }).first().click();
        await expect(page.locator(".mantine-Notification-root").first()).toBeVisible();
        await expect(
            dialog.getByRole("button", { name: "Install", exact: true }).first(),
        ).toBeEnabled();
        const retained = await page.evaluate(
            () =>
                JSON.parse(sessionStorage.getItem("__E2E_ENGINE_COMPLETIONS__") ?? "[]") as {
                    id: string;
                    request: { intent: { engine_id: string } };
                }[],
        );
        expect(retained).toHaveLength(1);
        await expectNotificationSettled(page.locator(".mantine-Notification-root").last());
        await capture(`engine-${kind}-reload-error-retry`);
        await preserveStorageForReload(page);
        await expect
            .poll(async () => {
                const raw = await page.evaluate(() => localStorage.getItem("engines"));
                return raw && (decodeCompressedOrJson(raw) as { value: unknown }).value;
            })
            .toMatchObject([
                {
                    id: retained[0].request.intent.engine_id,
                    handle: { id: { id: "recovered-binary" } },
                },
            ]);
        await expect
            .poll(() => page.evaluate(() => sessionStorage.getItem("__E2E_ENGINE_COMPLETIONS__")))
            .toBe("[]");
        const name = page.getByRole("textbox", { name: "Name", exact: true });
        if (kind === "add") await page.getByRole("button", { name: /new ELO/ }).click();
        await expect(name).toBeVisible();
        if (kind === "upgrade") {
            await expect(name).toHaveValue("Recovered Engine");
            for (const key of ["game-player1-settings", "game-player2-settings"]) {
                const raw = await page.evaluate((key) => localStorage.getItem(key), key);
                expect((decodeCompressedOrJson(raw!) as { value: unknown }).value).toMatchObject({
                    engine: { id: old.id, handle: { id: { id: "recovered-binary" } } },
                });
            }
        }
        expect(
            await page.evaluate(() =>
                window.__E2E_TAURI__
                    .invocations()
                    .filter(({ command }) => command === "install_engine_workflow"),
            ),
        ).toEqual([]);
        await capture(`engine-${kind}-reload-recovered`);
    });
}

test("accounts-puzzles-engines: local engine validation is visible before any native issuance", async ({
    page,
    mockScenario,
    capture,
}) => {
    // The engine catalog is bundled; mock its native signature check and CPU-capability query.
    await mockScenario({
        commands: {
            is_bmi2_compatible: { result: false },
            verify_signed_bytes: { result: null },
        },
    });
    await page.goto("/engines");
    await page.getByRole("button", { name: "Add New", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add Engine", exact: true });
    await dialog.getByRole("tab", { name: "Local", exact: true }).click();
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(dialog.getByText("Name is required", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Path is required", { exact: true })).toBeVisible();
    // The Add click scrolls the modal content to reveal the button, and where that scroll
    // settles varies between runs (f-20261011-07). Capture the validation state from the top.
    const content = page.locator(".mantine-Modal-content");
    await content.evaluate((element) => element.scrollTo({ top: 0 }));
    await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBe(0);
    const issuance = await page.evaluate(() =>
        window.__E2E_TAURI__
            .invocations()
            .filter(({ command }) =>
                ["issue_engine_binary", "issue_engine_image", "issue_engine_resource"].includes(
                    command,
                ),
            ),
    );
    expect(issuance).toEqual([]);
    await capture("engine-local-validation");
    await expect(dialog).toHaveScreenshot("engine-local-validation.png");
});

test("accounts-puzzles-engines: navigates empty account, puzzle, and engine states", async ({
    page,
    mockScenario,
    assertAccessible,
    assertNoHorizontalOverflow,
    capture,
}) => {
    // The puzzle catalog is bundled; only its native signature check is mocked.
    await mockScenario({ commands: { verify_signed_bytes: { result: null } } });
    await page.goto("/accounts");
    await expect(page.getByRole("button", { name: /add account/i })).toBeVisible();
    await page.getByRole("button", { name: /add account/i }).click();
    const accountDialog = page.getByRole("dialog", { name: /add account/i });
    await expect(accountDialog.getByLabel(/username/i)).toBeVisible();
    await accountDialog.getByRole("button", { name: /close/i }).click();

    await page.getByRole("link", { name: /engines/i }).click();
    await expect(page.getByRole("heading", { name: /engines/i })).toBeVisible();
    await expect(page.getByText(/no engines installed/i)).toBeVisible();

    await page.getByRole("link", { name: /board/i }).click();
    await page.getByRole("button", { name: /^train$/i }).click();
    await expect(page.getByText(/puzzle training/i)).toBeVisible();
    await assertNoHorizontalOverflow();
    await assertAccessible();
    await page.mouse.move(0, 0);
    await capture("accounts-puzzles-engines");
    await expect(page).toHaveScreenshot("accounts-puzzles-engines.png", { fullPage: true });
});

async function openTestPuzzle(
    page: Page,
    mockScenario: (scenario: MockScenario) => Promise<void>,
    options: {
        databaseId: string;
        databaseName: string;
        fontScale?: number;
        eraseDrawablesOnClick?: boolean;
    },
) {
    await page.addInitScript(({ databaseId, fontScale, eraseDrawablesOnClick }) => {
        if (fontScale !== undefined) localStorage.setItem("font-size", String(fontScale));
        localStorage.setItem("puzzle-db", JSON.stringify({ id: databaseId }));
        localStorage.setItem("track-puzzle-time", "false");
        if (eraseDrawablesOnClick === false)
            localStorage.setItem("erase-drawables-on-click", "false");
    }, options);
    await mockScenario({
        commands: {
            list_puzzle_databases: {
                result: [
                    {
                        title: `${options.databaseName}.db3`,
                        description: options.databaseName,
                        puzzleCount: 1,
                        storageSize: "1024",
                        path: { id: options.databaseId },
                    },
                ],
            },
            get_puzzle_themes: { result: [] },
            get_themes_for_puzzle: { result: [] },
            get_puzzle: {
                result: {
                    id: 7,
                    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1",
                    moves: "e7e5 g1f3 b8c6 b1c3",
                    rating: 1200,
                    rating_deviation: 50,
                    popularity: 1,
                    nb_plays: 1,
                },
            },
        },
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Train", exact: true }).click();
    await page.getByRole("button", { name: "New Puzzle", exact: true }).click();
}

test.describe("stacked puzzle geometry", () => {
    test.use({ viewport: { width: 320, height: 720 } });

    test("accounts-puzzles-engines: puzzle board fills its narrow tile at 200%", async ({
        page,
        mockScenario,
    }) => {
        await openTestPuzzle(page, mockScenario, {
            databaseId: "geometry-puzzles",
            databaseName: "Geometry",
            fontScale: 200,
        });
        await expect(
            page.getByRole("button", { name: "Challenge 1: incomplete", exact: true }),
        ).toBeVisible();
        await expect(page.locator('[data-board-layout="stacked"]')).toHaveCount(1);
        await expect(page.locator("html")).toHaveCSS("font-size", "32px");
        // PuzzleBoard's ResizeObserver sizes the square from its tile height.
        await expect
            .poll(async () => {
                return page.locator("#left cg-board").evaluate((board) => {
                    const tile = document.getElementById("left")!;
                    return board.getBoundingClientRect().width / tile.clientWidth;
                });
            })
            .toBeGreaterThanOrEqual(0.9);
        const geometry = await page.locator("#left").evaluate((tile) => {
            const style = getComputedStyle(tile);
            const square = tile.querySelector("cg-board")!.getBoundingClientRect();
            const innerWidth =
                tile.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
            const innerHeight =
                tile.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
            return {
                innerWidth,
                innerHeight,
                squareWidth: square.width,
                squareHeight: square.height,
                emptySpace: Math.max(0, innerHeight - square.height),
                rootFont: parseFloat(getComputedStyle(document.documentElement).fontSize),
                scrollWidth: document.documentElement.scrollWidth,
                viewport: window.innerWidth,
                tileScrollWidth: tile.scrollWidth,
                tileClientWidth: tile.clientWidth,
            };
        });
        console.log(`320x720/200% puzzle geometry ${JSON.stringify(geometry)}`);
        expect(geometry.squareWidth).toBeGreaterThanOrEqual(geometry.innerWidth * 0.9);
        expect(Math.abs(geometry.squareWidth - geometry.squareHeight)).toBeLessThanOrEqual(1);
        expect(geometry.squareHeight).toBeLessThanOrEqual(geometry.innerHeight + 1);
        expect(geometry.emptySpace).toBeLessThanOrEqual(geometry.rootFont);
        expect(geometry.tileScrollWidth).toBeLessThanOrEqual(geometry.tileClientWidth);
        expect(geometry.scrollWidth).toBe(geometry.viewport);
    });
});

for (const erase of [true, false]) {
    test(`accounts-puzzles-engines: puzzle marks survive progressive hints, toggle and honor erase ${erase}`, async ({
        page,
        mockScenario,
        capture,
    }) => {
        await openTestPuzzle(page, mockScenario, {
            databaseId: "drawing-puzzles",
            databaseName: "Drawings",
            eraseDrawablesOnClick: erase,
        });
        const board = page.locator("cg-board").first();
        await expect(
            page.getByRole("button", { name: "Challenge 1: incomplete", exact: true }),
        ).toBeVisible();
        const svg = page.locator(".cg-wrap svg.cg-shapes").first();
        const circles = svg.locator("g[cgHash] circle");
        const arrows = svg.locator("g[cgHash] line");
        await drawMark(page, board, "c4");
        await expect(circles).toHaveCount(1);
        await drawMark(page, board, "d4");
        await expect(circles).toHaveCount(2);
        const retainedCircle = await circles.last().getAttribute("cx");
        await drawMark(page, board, "a3", "a5");
        await expect(arrows).toHaveCount(1);
        const retainedArrow = await arrows.getAttribute("x1");
        const hint = page.getByRole("button", { name: "Get a Hint", exact: true });
        await hint.click();
        await expect(circles).toHaveCount(3);
        await expect(arrows).toHaveCount(1);
        await capture(`puzzle-user-marks-with-hint-erase-${erase}`);
        await hint.click();
        await expect(circles).toHaveCount(2);
        await expect(arrows).toHaveCount(2);
        await hint.click();
        await expect(circles).toHaveCount(2);
        await expect(arrows).toHaveCount(1);
        await expect(arrows).toHaveAttribute("x1", retainedArrow!);
        await drawMark(page, board, "c4");
        await expect(circles).toHaveCount(1);
        await expect(circles).toHaveAttribute("cx", retainedCircle!);
        await drawMark(page, board, "a3", "a5");
        await expect(arrows).toHaveCount(0);
        await drawMark(page, board, "b3", "b5");
        await expect(arrows).toHaveCount(1);
        await board.click();
        await expect(circles).toHaveCount(erase ? 0 : 1);
        await expect(arrows).toHaveCount(erase ? 0 : 1);
        if (!erase) {
            await drawMark(page, board, "d4");
            await expect(circles).toHaveCount(0);
            await expect(arrows).toHaveCount(1);
        }
    });
}

test("accounts-puzzles-engines: selected puzzle B survives reload, refused admission retries and close reclaims its keys", async ({
    page,
    mockScenario,
    capture,
}) => {
    const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1";
    const row = { id: 7, fen, rating: 1200, rating_deviation: 50, popularity: 1, nb_plays: 1 };
    const a = { ...row, moves: "e7e6 d2d4" };
    const b = { ...row, moves: "e7e5 g1f3 b8c6 b1c3" };
    await page.addInitScript(() => {
        localStorage.setItem("font-size", "100");
        localStorage.setItem("puzzle-db", JSON.stringify({ id: "session-puzzles" }));
        localStorage.setItem("track-puzzle-time", "false");
        localStorage.setItem("puzzle-jump-immediately", "false");
    });
    await mockScenario({
        commands: {
            list_puzzle_databases: {
                result: [
                    {
                        title: "Session.db3",
                        description: "Session",
                        puzzleCount: 2,
                        storageSize: "1024",
                        path: { id: "session-puzzles" },
                    },
                ],
            },
            get_puzzle_themes: { result: [] },
            get_themes_for_puzzle: { result: [] },
            get_puzzle: { results: [a, b], result: b },
        },
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Train", exact: true }).click();
    const next = page.getByRole("button", { name: "New Puzzle", exact: true });
    await expect(next).toBeEnabled();
    await next.click();
    await expect(
        page.getByRole("button", { name: "Challenge 1: incomplete", exact: true }),
    ).toBeVisible();
    await next.click();
    await expect(
        page.getByRole("button", { name: "Challenge 2: incomplete", exact: true }),
    ).toBeVisible();
    const tab = (await activeWorkspaceTab(page))!;
    const key = tab.treeKey ?? tab.value;
    const read = async () =>
        deserializeStorageValue<{ state: TreeState }>(
            (await page.evaluate((key) => sessionStorage.getItem(key), key))!,
        )!.state;
    const savedSession = (await read()).puzzleSession;
    expect(savedSession).toMatchObject({
        version: 1,
        attempts: [
            { puzzle: { moves: a.moves.split(" ") } },
            { puzzle: { moves: b.moves.split(" ") } },
        ],
        selectedAttemptId: expect.any(String),
    });
    const selectedB = savedSession!.selectedAttemptId;
    await playBoardMove(page, page.locator("cg-board"), "g1", "f3");
    await expect.poll(async () => (await read()).position.length).toBe(3);
    const progress = await read();
    await capture("puzzle-session-b-progress");
    await preserveStorageForReload(page);
    await expect(next).toBeEnabled();
    await expect(
        page.getByRole("button", { name: "Challenge 2: incomplete", exact: true }),
    ).toBeVisible();
    expect((await read()).puzzleSession!.selectedAttemptId).toBe(selectedB);
    expect((await read()).position).toEqual(progress.position);
    expect((await read()).root).toEqual(progress.root);
    await capture("puzzle-session-b-reloaded");
    const sourceBytes = await page.evaluate((key) => sessionStorage.getItem(key), key);
    await page.getByRole("button", { name: "Tab actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Duplicate tab", exact: true }).click();
    const copy = (await activeWorkspaceTab(page))!;
    expect(copy.value).not.toBe(tab.value);
    const copyKey = copy.treeKey ?? copy.value;
    const readCopy = async () =>
        deserializeStorageValue<{ state: TreeState }>(
            (await page.evaluate((key) => sessionStorage.getItem(key), copyKey))!,
        )!.state;
    const copiedSession = (await readCopy()).puzzleSession;
    expect(copiedSession).toMatchObject({ version: 1, selectedAttemptId: selectedB });
    expect(copiedSession).toEqual(progress.puzzleSession);
    expect((await readCopy()).puzzleSession!.selectedAttemptId).toBe(selectedB);
    expect((await readCopy()).root).toEqual(progress.root);
    expect((await readCopy()).position).toEqual(progress.position);
    await capture("puzzle-session-independent-copy");
    const copyBytes = await page.evaluate((key) => sessionStorage.getItem(key), copyKey);
    await refusePuzzleStorage(page, copyKey);
    await playBoardMove(page, page.locator("cg-board"), "b1", "c3");
    const retry = page.getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toBeVisible();
    expect(await page.evaluate((key) => sessionStorage.getItem(key), copyKey)).toBe(copyBytes);
    expect((await readCopy()).puzzleSession!.attempts[1].puzzle.completion).toBe("incomplete");
    expect(await page.evaluate((key) => sessionStorage.getItem(key), key)).toBe(sourceBytes);
    await capture("puzzle-session-completion-refused-retry");
    await restorePuzzleStorage(page);
    await retry.click();
    await expect(retry).not.toBeVisible();
    await expect
        .poll(async () => (await readCopy()).puzzleSession!.attempts[1].puzzle.completion)
        .toBe("correct");
    expect((await readCopy()).puzzleSession!.selectedAttemptId).toBe(selectedB);
    expect((await readCopy()).position.length).toBe(4);
    expect((await read()).puzzleSession!.attempts[1].puzzle.completion).toBe("incomplete");
    expect((await read()).position).toEqual(progress.position);
    expect(await page.evaluate((key) => sessionStorage.getItem(key), key)).toBe(sourceBytes);
    await capture("puzzle-session-completion-retried");
    await page.getByRole("button", { name: "Close tab", exact: true }).click();
    await expect
        .poll(() => page.evaluate((key) => sessionStorage.getItem(key), copyKey))
        .toBeNull();
    expect((await activeWorkspaceTab(page))!.value).toBe(tab.value);
    expect((await read()).root).toEqual(progress.root);
    expect((await read()).puzzleSession!.selectedAttemptId).toBe(selectedB);
    const before = await page.evaluate((key) => sessionStorage.getItem(key), key);
    await refusePuzzleStorage(page, key);
    await next.click();
    await expect(page.getByText(/storage|quota/i).last()).toBeVisible();
    expect(await page.evaluate((key) => sessionStorage.getItem(key), key)).toBe(before);
    expect((await read()).puzzleSession!.selectedAttemptId).toBe(selectedB);
    await capture("puzzle-session-save-refused");
    await restorePuzzleStorage(page);
    await next.click();
    await expect(
        page.getByRole("button", { name: "Challenge 3: incomplete", exact: true }),
    ).toBeVisible();
    expect((await read()).puzzleSession!.selectedAttemptId).not.toBe(selectedB);
    await capture("puzzle-session-save-retried");
    await page.evaluate((logical) => sessionStorage.setItem(`${logical}-puzzles`, "[]"), tab.value);
    await page.getByRole("button", { name: "Close tab", exact: true }).click();
    await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), key)).toBeNull();
    expect(
        await page.evaluate((logical) => sessionStorage.getItem(`${logical}-puzzles`), tab.value),
    ).toBeNull();
    await capture("puzzle-session-closed-keys-reclaimed");
});

test("accounts-puzzles-engines: moves the active sidebar marker with navigation", async ({
    page,
    mockScenario,
}) => {
    await mockScenario({ commands: {} });
    await page.goto("/");

    const navbar = page.locator("nav.mantine-AppShell-navbar");
    const linkNames = ["User", "Library", "Engines", "Settings", "Board"];
    const noMarker = "none";
    await expect(navbar.getByRole("link")).toHaveCount(linkNames.length);

    for (const name of linkNames) {
        const clickedLink = navbar.getByRole("link", { name, exact: true });
        await clickedLink.click();
        await expect(clickedLink).toHaveAttribute("aria-current", "page");
        await expect(navbar.locator('a[aria-current="page"]')).toHaveCount(1);
        await expect
            .poll(() => clickedLink.evaluate((link) => getComputedStyle(link).backgroundImage))
            .not.toBe(noMarker);
        // WebKitGTK paints a coloured side border's colour into the opposite rounded
        // corners; Chromium does not, so guard the cause rather than the pixels.
        expect(
            await clickedLink.evaluate((link) => {
                const style = getComputedStyle(link);
                return [style.borderLeftWidth, style.borderRightWidth];
            }),
        ).toEqual(["0px", "0px"]);

        for (const otherName of linkNames) {
            if (otherName === name) continue;

            const otherLink = navbar.getByRole("link", { name: otherName, exact: true });
            await expect(otherLink).not.toHaveAttribute("aria-current", "page");
            await expect
                .poll(() => otherLink.evaluate((link) => getComputedStyle(link).backgroundImage))
                .toBe(noMarker);
        }
    }
});
