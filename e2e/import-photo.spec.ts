import { expect, preserveStorageForReload, test, waitForTransitionsSettled } from "./fixtures";
import {
    importFromPhoto,
    PHOTO_DATA_URL,
    scoresheetConnection,
    scoresheetModels,
    scoresheetPhotoCommands,
    stubScoresheetGame,
    stubScoresheetPgnTokens,
} from "./scoresheetPhotoImport";

test("import from photo shows hint without a connection", async ({ page, mockScenario }) => {
    await mockScenario({
        commands: {
            coach_available: { result: true },
            coach_has_connection: { result: false },
            coach_connections: { result: [] },
        },
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Import", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Import Game" });
    await dialog.getByRole("button", { name: "Photo", exact: true }).click();
    await expect(
        dialog.getByText("Reading a scoresheet photo requires an AI connection."),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Open AI settings" })).toBeVisible();
    await waitForTransitionsSettled(page);
    await expect(dialog).toHaveScreenshot("import-photo-no-connection.png");
});

test("import from photo reads stubbed game and opens review tab with Photo panel and marked move", async ({
    page,
    mockScenario,
}) => {
    await mockScenario({ commands: scoresheetPhotoCommands() });
    await page.goto("/");
    await importFromPhoto(page, {
        onBeforeRead: async (dialog) => {
            await waitForTransitionsSettled(page);
            await expect(dialog).toHaveScreenshot("import-photo-with-connection.png");
        },
    });

    // The new analysis tab opens with the Photo panel active and `e5` marked unsure.
    await expect(page.getByRole("tab", { name: "Photo", exact: true })).toHaveAttribute(
        "aria-selected",
        "true",
    );
    await expect(page.getByText("1 move to check")).toBeVisible();
    await expect(page.locator("[data-notation-unsure]")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Finish review" })).toHaveCount(0);
    await expect(page.locator("[data-scoresheet-page-overlay]")).toHaveCount(0);
    await expect(page.locator("[data-scoresheet-enlarge-overlay]")).toBeVisible();

    // Controls sit on one row at normal width.
    const rowGeometry = await page.locator("[data-scoresheet-review-row]").evaluate((row) => {
        const count = row.querySelector("[data-scoresheet-unsure-count]")!.getBoundingClientRect();
        const mark = Array.from(row.querySelectorAll("button"))
            .find((b) => b.textContent?.includes("Mark as checked"))!
            .getBoundingClientRect();
        return {
            sameRow: mark.top < count.bottom && count.top < mark.bottom,
        };
    });
    expect(rowGeometry.sameRow).toBe(true);

    await waitForTransitionsSettled(page);
    await expect(page).toHaveScreenshot("import-photo-review-tab.png");

    // Checking the only unsure move removes "Mark as checked" and shows "All moves checked".
    await page.getByRole("button", { name: "Next move to check", exact: true }).click();
    const markBtn = page.getByRole("button", { name: "Mark as checked", exact: true });
    await expect(markBtn).toBeEnabled();
    await markBtn.click();
    await expect(page.getByText("All moves checked")).toBeVisible();
    await expect(markBtn).toHaveCount(0);
});

test("Photo panel overlays work in full-size mode without covering scrollbars", async ({
    page,
    mockScenario,
}) => {
    await mockScenario({ commands: scoresheetPhotoCommands() });
    await page.goto("/");

    // Return two large (1000x1000) valid JPEGs so full-size mode produces real scrollbars.
    await page.evaluate(() => {
        const internals = (
            window as unknown as {
                __TAURI_INTERNALS__: {
                    invoke: (cmd: string, args?: unknown) => Promise<unknown>;
                };
            }
        ).__TAURI_INTERNALS__;
        const origInvoke = internals.invoke.bind(internals);
        const makeLargeJpeg = (fill: string) => {
            const canvas = document.createElement("canvas");
            canvas.width = 1000;
            canvas.height = 1000;
            const ctx = canvas.getContext("2d")!;
            ctx.fillStyle = fill;
            ctx.fillRect(0, 0, 1000, 1000);
            return canvas.toDataURL("image/jpeg", 0.5);
        };
        const large1 = makeLargeJpeg("#f5f0e6");
        const large2 = makeLargeJpeg("#e6f0f5");
        internals.invoke = async (cmd: string, args?: unknown) => {
            if (cmd === "scoresheet_pick_photos") {
                return {
                    photos: [{ dataUrl: large1 }, { dataUrl: large2 }],
                    skipped: 0,
                    failed: 0,
                };
            }
            return origInvoke(cmd, args);
        };
    });

    await importFromPhoto(page, { expectedPhotoCount: 2 });

    const viewport = page.locator("[data-scoresheet-photo-size]");
    const enlargeOverlay = page.locator("[data-scoresheet-enlarge-overlay]");
    const pageOverlay = page.locator("[data-scoresheet-page-overlay]");
    await expect(viewport).toHaveAttribute("data-scoresheet-photo-size", "fit");
    await expect(enlargeOverlay).toBeVisible();
    await expect(pageOverlay).toBeVisible();
    await expect(pageOverlay.locator("[data-scoresheet-page]")).toHaveText("Page 1 of 2");

    // Switch to full-size mode and verify overflow + overlay geometry stays inside client area (not over scrollbars).
    await page.getByRole("button", { name: "Full size", exact: true }).click();
    await expect(viewport).toHaveAttribute("data-scoresheet-photo-size", "full");

    await expect
        .poll(async () =>
            viewport.evaluate(
                (el) => el.scrollWidth > el.clientWidth && el.scrollHeight > el.clientHeight,
            ),
        )
        .toBe(true);

    const geometry = await page.evaluate(() => {
        const vp = document.querySelector<HTMLElement>("[data-scoresheet-photo-size]")!;
        const enlarge = document.querySelector<HTMLElement>("[data-scoresheet-enlarge-overlay]")!;
        const pager = document.querySelector<HTMLElement>("[data-scoresheet-page-overlay]")!;
        const vpRect = vp.getBoundingClientRect();
        const enlargeRect = enlarge.getBoundingClientRect();
        const pagerRect = pager.getBoundingClientRect();
        const clientRight = vpRect.left + vp.clientWidth;
        const clientBottom = vpRect.top + vp.clientHeight;
        return {
            enlargeTopOk:
                enlargeRect.top >= vpRect.top && enlargeRect.top < vpRect.top + vp.clientHeight / 2,
            enlargeRightOk:
                enlargeRect.right <= clientRight &&
                enlargeRect.left >= vpRect.left + vp.clientWidth / 2,
            pagerBottomOk:
                pagerRect.bottom <= clientBottom &&
                pagerRect.bottom > vpRect.top + vp.clientHeight / 2,
            pagerHorizOk: pagerRect.left >= vpRect.left && pagerRect.right <= clientRight,
        };
    });
    expect(geometry).toEqual({
        enlargeTopOk: true,
        enlargeRightOk: true,
        pagerBottomOk: true,
        pagerHorizOk: true,
    });

    // Both overlays remain clickable in full-size mode.
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(pageOverlay.locator("[data-scoresheet-page]")).toHaveText("Page 2 of 2");
    await page.getByRole("button", { name: "Fit to panel", exact: true }).click();
    await expect(viewport).toHaveAttribute("data-scoresheet-photo-size", "fit");
});

test("import from photo keeps the mode cards even below the header and shows reading progress", async ({
    page,
    mockScenario,
}) => {
    await mockScenario({
        commands: {
            coach_available: { result: true },
            coach_has_connection: { result: true },
            coach_connections: { result: [scoresheetConnection] },
            coach_models: { result: scoresheetModels },
            scoresheet_pick_photos: {
                result: { photos: [{ dataUrl: PHOTO_DATA_URL }], skipped: 0, failed: 0 },
            },
            // Held long enough that the whole progress state can be inspected.
            scoresheet_read: { result: stubScoresheetGame, delay: 600_000 },
        },
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Import", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Import Game" });
    const photoCard = dialog.getByRole("button", { name: "Photo", exact: true });
    await photoCard.click();

    // A label that wraps must make every card taller together, and the row keeps a gap under the
    // header's divider instead of touching it.
    // The card's accessible name changes with its label, so keep a handle to the same element.
    const photoCardHandle = await photoCard.elementHandle();
    const singleLineHeight = (await photoCard.boundingBox())!.height;
    const relabelled = await photoCardHandle!.evaluate((card) => {
        const label = card.querySelector("p");
        if (!label) return false;
        label.textContent = "A much longer label that has to wrap onto two lines";
        return true;
    });
    expect(relabelled).toBe(true);
    expect((await photoCardHandle!.boundingBox())!.height).toBeGreaterThan(singleLineHeight);
    const header = dialog.locator(".mantine-Modal-header");
    const cards = dialog.locator("fieldset").first().getByRole("button");
    await expect(cards).toHaveCount(4);
    const headerBox = await header.boundingBox();
    const boxes = await Promise.all(
        Array.from({ length: 4 }, (_, index) => cards.nth(index).boundingBox()),
    );
    expect(headerBox).not.toBeNull();
    const heights = boxes.map((box) => Math.round(box!.height));
    expect(new Set(heights).size).toBe(1);
    for (const box of boxes) {
        expect(box!.y - (headerBox!.y + headerBox!.height)).toBeGreaterThanOrEqual(8);
    }
    await photoCardHandle!.evaluate((card) => {
        const label = card.querySelector("p");
        if (label) label.textContent = "Photo";
    });

    await dialog.getByRole("button", { name: "Choose photos or PDF", exact: true }).click();
    await expect(dialog.locator("[data-scoresheet-thumbnails] img")).toHaveCount(1);
    await dialog.getByRole("button", { name: /^AI model: / }).click();
    await page.getByRole("textbox", { name: "Model" }).click();
    await page.getByRole("option", { name: "Vision Model" }).click();
    await dialog.getByText("Import Game", { exact: true }).click();

    await dialog.getByRole("button", { name: "Read game" }).click();
    await page
        .getByRole("dialog", { name: "Before you send photos" })
        .getByRole("button", { name: "Send photos", exact: true })
        .click();

    const progress = dialog.getByRole("button", { name: "Reading the scoresheet…" });
    await expect(progress).toBeVisible();
    await expect(progress).toHaveAttribute("aria-busy", "true");
    await expect(progress.locator(".mantine-Loader-root")).toBeVisible();
    const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
    await expect(cancel).toBeVisible();
    await expect(dialog.getByText("This can take a minute.", { exact: true })).toBeVisible();
    // The progress button spans the pane, like the button it replaces.
    const progressBox = await progress.boundingBox();
    const cancelBox = await cancel.boundingBox();
    expect(Math.round(progressBox!.width)).toBe(Math.round(cancelBox!.width));
    expect(cancelBox!.y).toBeGreaterThan(progressBox!.y);
    // Switching mode is blocked while the reading runs.
    await expect(dialog.getByRole("button", { name: "PGN", exact: true })).toBeDisabled();
    await waitForTransitionsSettled(page);
    await expect(dialog).toHaveScreenshot("import-photo-reading.png");

    await cancel.click();
    await expect(dialog.getByRole("button", { name: "Read game" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "PGN", exact: true })).toBeEnabled();
    await expect(dialog.locator("[data-scoresheet-thumbnails] img")).toHaveCount(1);
});

test("save imported photo game to PGN file, close tab, and reopen shows Photo tab with photo", async ({
    page,
    mockScenario,
}) => {
    const savedHandle = { id: { id: "e2e-scoresheet-pgn-file" }, kind: "fileWorkspace" } as const;
    const savedRevision = "e2e-scoresheet-pgn-rev-1";
    const savedStamp = "f".repeat(64);
    const savedGrant = {
        handle: savedHandle,
        displayName: "Scoresheet game.pgn",
        availability: "available" as const,
    };

    await mockScenario({
        commands: {
            ...scoresheetPhotoCommands(),
            issue_pgn_export_destination: { result: savedGrant },
            issue_pgn_workspace: { result: savedGrant },
            write_game: { result: { stamp: savedStamp, revision: savedRevision } },
            count_pgn_games: { result: 0 },
            file_revision: { result: savedRevision },
        },
    });
    const installPgnRoundTrip = () =>
        page.evaluate(
            ({ baseTokens, revision, stamp }) => {
                const pgnKey = "__E2E_SAVED_SCORESHEET_PGN__";
                const internals = (
                    window as unknown as {
                        __TAURI_INTERNALS__: {
                            invoke: (
                                cmd: string,
                                args?: Record<string, unknown>,
                            ) => Promise<unknown>;
                        };
                    }
                ).__TAURI_INTERNALS__;
                const origInvoke = internals.invoke.bind(internals);
                internals.invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
                    if (cmd === "write_game") {
                        sessionStorage.setItem(pgnKey, String(args.pgn ?? ""));
                        return origInvoke(cmd, args);
                    }
                    if (cmd === "count_pgn_games") {
                        return sessionStorage.getItem(pgnKey) ? 1 : 0;
                    }
                    if (cmd === "read_game") {
                        const savedPgn = sessionStorage.getItem(pgnKey) ?? "";
                        return { pgn: savedPgn, stamp, revision, present: true };
                    }
                    if (cmd === "read_games") {
                        const savedPgn = sessionStorage.getItem(pgnKey) ?? "";
                        return savedPgn ? [{ pgn: savedPgn, stamp, revision, present: true }] : [];
                    }
                    if (cmd === "lex_pgn") {
                        const pgn = String(args.pgn ?? "");
                        const match = pgn.match(/\[ScoresheetPhotos "([^"]+)"\]/);
                        if (match) {
                            return [
                                {
                                    type: "Header",
                                    value: { tag: "ScoresheetPhotos", value: match[1] },
                                },
                                ...baseTokens,
                            ];
                        }
                        return baseTokens;
                    }
                    return origInvoke(cmd, args);
                };
            },
            { baseTokens: stubScoresheetPgnTokens, revision: savedRevision, stamp: savedStamp },
        );

    await page.goto("/");
    await installPgnRoundTrip();

    await importFromPhoto(page);
    await expect(page.getByRole("tab", { name: "Photo", exact: true })).toHaveAttribute(
        "aria-selected",
        "true",
    );

    // Save the imported game to a PGN file and verify the written PGN carries ScoresheetPhotos.
    await page.getByRole("button", { name: /^save pgn/i }).click();
    await expect(page.locator("[data-file-freshness]")).toHaveAttribute(
        "data-file-freshness",
        /^verified:/,
    );
    const writtenPgn = await page.evaluate(() => {
        const writeCall = window.__E2E_TAURI__
            .invocations()
            .find((item) => item.command === "write_game");
        return String((writeCall?.args as { pgn?: string } | undefined)?.pgn ?? "");
    });
    const tagMatch = writtenPgn.match(/\[ScoresheetPhotos "([0-9a-f]{64})"\]/);
    expect(tagMatch).not.toBeNull();
    const savedPhotoId = tagMatch![1];

    // Close the analysis tab, then reload the page to drop the renderer's in-memory photo cache.
    await page.getByRole("tab", { name: "Alice - Bob" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Close tab", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Photo", exact: true })).toHaveCount(0);

    await preserveStorageForReload(page);
    await installPgnRoundTrip();

    // Reopen the saved PGN file via Application menu -> Open File.
    await page.getByRole("button", { name: "Application menu", exact: true }).click();
    await page.getByRole("menuitem", { name: "Open File" }).click();

    // The reopened game has no active review, yet offers the Photo tab and loads the photo through scoresheet_read_photos.
    const photoTab = page.getByRole("tab", { name: "Photo", exact: true });
    await expect(photoTab).toBeVisible();
    await photoTab.click();
    await expect(page.locator("[data-scoresheet-photo-size] img")).toHaveAttribute(
        "src",
        PHOTO_DATA_URL,
    );
    await expect(page.locator("[data-scoresheet-review-row]")).toHaveCount(0);

    const readPhotoCalls = await page.evaluate(() =>
        window.__E2E_TAURI__
            .invocations()
            .filter((item) => item.command === "scoresheet_read_photos")
            .map((item) => item.args),
    );
    expect(readPhotoCalls).toContainEqual(expect.objectContaining({ ids: [savedPhotoId] }));
});

test("multi-page missing photo keeps page overlay anchored inside the empty box", async ({
    page,
    mockScenario,
}) => {
    const idMissing = "a".repeat(64);
    const idOk = "b".repeat(64);
    const grant = {
        handle: { id: { id: "e2e-missing-2page" }, kind: "fileWorkspace" } as const,
        displayName: "Missing photo.pgn",
        availability: "available" as const,
    };
    const pgn = `[ScoresheetPhotos "${idMissing},${idOk}"]\n[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n1. e4 e5 1-0\n`;

    await mockScenario({
        commands: {
            issue_pgn_workspace: { result: grant },
            count_pgn_games: { result: 1 },
            file_revision: { result: "rev-missing-1" },
            read_game: {
                result: { pgn, stamp: "c".repeat(64), revision: "rev-missing-1", present: true },
            },
            lex_pgn: {
                result: [
                    {
                        type: "Header",
                        value: { tag: "ScoresheetPhotos", value: `${idMissing},${idOk}` },
                    },
                    ...stubScoresheetPgnTokens,
                ],
            },
            scoresheet_read_photos: {
                result: [{ status: "missing" }, { status: "ok", dataUrl: PHOTO_DATA_URL }],
            },
        },
    });
    await page.goto("/");

    await page.getByRole("button", { name: "Application menu", exact: true }).click();
    await page.getByRole("menuitem", { name: "Open File" }).click();

    const photoTab = page.getByRole("tab", { name: "Photo", exact: true });
    await expect(photoTab).toBeVisible();
    await photoTab.click();

    const emptyBox = page.locator("[data-scoresheet-no-photo]");
    const pageOverlay = page.locator("[data-scoresheet-page-overlay]");
    await expect(emptyBox).toBeVisible();
    await expect(pageOverlay).toBeVisible();

    const geometry = await page.evaluate(() => {
        const box = document.querySelector<HTMLElement>("[data-scoresheet-no-photo]")!;
        const pager = document.querySelector<HTMLElement>("[data-scoresheet-page-overlay]")!;
        const boxRect = box.getBoundingClientRect();
        const pagerRect = pager.getBoundingClientRect();
        return {
            position: getComputedStyle(box).position,
            insideVertically: pagerRect.top >= boxRect.top && pagerRect.bottom <= boxRect.bottom,
            insideHorizontally: pagerRect.left >= boxRect.left && pagerRect.right <= boxRect.right,
        };
    });
    expect(geometry).toEqual({
        position: "relative",
        insideVertically: true,
        insideHorizontally: true,
    });
});

test("selecting a move turns to its photo page and marks its cell in fit and full-size mode", async ({
    page,
    mockScenario,
}) => {
    // Move 1 on the first photo, moves 2–21 on the second, lower right so full size has to scroll.
    const layout = [
        {
            page: 0,
            firstMove: 1,
            rows: 1,
            topLeft: [100, 100] as [number, number],
            topRight: [500, 100] as [number, number],
            bottomLeft: [100, 300] as [number, number],
            bottomRight: [500, 300] as [number, number],
        },
        {
            page: 1,
            firstMove: 2,
            rows: 20,
            topLeft: [500, 600] as [number, number],
            topRight: [900, 600] as [number, number],
            bottomLeft: [500, 980] as [number, number],
            bottomRight: [900, 980] as [number, number],
        },
    ];
    await mockScenario({
        commands: {
            ...scoresheetPhotoCommands(),
            scoresheet_read: { result: { ...stubScoresheetGame, layout } },
        },
    });
    await page.goto("/");

    // Two large portrait photos with the printed blocks drawn on them.
    await page.evaluate((blocks) => {
        const internals = (
            window as unknown as {
                __TAURI_INTERNALS__: {
                    invoke: (cmd: string, args?: unknown) => Promise<unknown>;
                };
            }
        ).__TAURI_INTERNALS__;
        const origInvoke = internals.invoke.bind(internals);
        const makeSheet = (pageIndex: number) => {
            const canvas = document.createElement("canvas");
            // Different sizes per page, so a size read before the next photo loads would misplace it.
            canvas.width = pageIndex === 0 ? 1200 : 1500;
            canvas.height = pageIndex === 0 ? 1600 : 1900;
            const ctx = canvas.getContext("2d")!;
            ctx.fillStyle = "#f5f0e6";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.strokeStyle = "#555555";
            ctx.lineWidth = 3;
            for (const block of blocks.filter((b) => b.page === pageIndex)) {
                const x = (block.topLeft[0] / 1000) * canvas.width;
                const y = (block.topLeft[1] / 1000) * canvas.height;
                const w = ((block.topRight[0] - block.topLeft[0]) / 1000) * canvas.width;
                const h = ((block.bottomLeft[1] - block.topLeft[1]) / 1000) * canvas.height;
                ctx.strokeRect(x, y, w, h);
                ctx.beginPath();
                ctx.moveTo(x + w / 2, y);
                ctx.lineTo(x + w / 2, y + h);
                for (let row = 1; row < block.rows; row += 1) {
                    ctx.moveTo(x, y + (h * row) / block.rows);
                    ctx.lineTo(x + w, y + (h * row) / block.rows);
                }
                ctx.stroke();
            }
            return canvas.toDataURL("image/jpeg", 0.6);
        };
        const sheets = [makeSheet(0), makeSheet(1)];
        internals.invoke = async (cmd: string, args?: unknown) => {
            if (cmd === "scoresheet_pick_photos") {
                return {
                    photos: sheets.map((dataUrl) => ({ dataUrl })),
                    skipped: 0,
                    failed: 0,
                };
            }
            return origInvoke(cmd, args);
        };
    }, layout);

    await importFromPhoto(page, { expectedPhotoCount: 2 });

    const notation = page.locator("[data-notation-rows]").first();
    const viewport = page.locator("[data-scoresheet-photo-size]");
    const pageLabel = page.locator("[data-scoresheet-page]");
    const marker = page.locator("[data-scoresheet-cell-marker] polygon");

    /** Marker bounds as fractions of the drawn image, and whether it lies inside the viewport. */
    const markerGeometry = () =>
        page.evaluate(() => {
            const image = document.querySelector<HTMLImageElement>(
                "[data-scoresheet-photo-size] img",
            )!;
            const polygon = document.querySelector("[data-scoresheet-cell-marker] polygon")!;
            const vp = document.querySelector<HTMLElement>("[data-scoresheet-photo-size]")!;
            const img = image.getBoundingClientRect();
            const box = polygon.getBoundingClientRect();
            const view = vp.getBoundingClientRect();
            const round = (value: number) => Math.round(value * 1000) / 1000;
            return {
                left: round((box.left - img.left) / img.width),
                right: round((box.right - img.left) / img.width),
                top: round((box.top - img.top) / img.height),
                bottom: round((box.bottom - img.top) / img.height),
                inView:
                    box.left >= view.left &&
                    box.right <= view.left + vp.clientWidth &&
                    box.top >= view.top &&
                    box.bottom <= view.top + vp.clientHeight,
            };
        });
    const expectNear = (actual: number, expected: number) =>
        expect(Math.abs(actual - expected)).toBeLessThan(0.012);

    // Fit mode, move 1 White: first photo, the left half of the only row, widened by the margin.
    await notation.getByRole("button", { name: "e4", exact: true }).click();
    await expect(pageLabel).toHaveText("Page 1 of 2");
    await expect(marker).toBeVisible();
    let geometry = await markerGeometry();
    expectNear(geometry.left, 0.088);
    expectNear(geometry.right, 0.312);
    expectNear(geometry.top, 0.06);
    expectNear(geometry.bottom, 0.34);
    expect(geometry.inView).toBe(true);
    await waitForTransitionsSettled(page);
    await expect(page.locator("[data-scoresheet-photo-size]")).toHaveScreenshot(
        "import-photo-cell-marker-fit.png",
    );

    // Move 2 White lives on the second photo: the page turns with the selection.
    await notation.getByRole("button", { name: /f3$/ }).click();
    await expect(pageLabel).toHaveText("Page 2 of 2");
    geometry = await markerGeometry();
    expectNear(geometry.left, 0.488);
    expectNear(geometry.right, 0.712);
    expectNear(geometry.top, 0.5962);
    expectNear(geometry.bottom, 0.6228);

    // Full size: the marker stays on the same image region and is scrolled into view.
    await page.getByRole("button", { name: "Full size", exact: true }).click();
    await expect(viewport).toHaveAttribute("data-scoresheet-photo-size", "full");
    await expect
        .poll(async () =>
            viewport.evaluate((el) => el.scrollHeight > el.clientHeight && el.scrollTop > 0),
        )
        .toBe(true);
    geometry = await markerGeometry();
    expectNear(geometry.left, 0.488);
    expectNear(geometry.top, 0.5962);
    expect(geometry.inView).toBe(true);

    // Scrolled away, the next selection brings its cell back into view.
    await viewport.evaluate((el) => {
        el.scrollTop = 0;
        el.scrollLeft = 0;
    });
    await notation.getByRole("button", { name: /c6$/ }).click();
    await expect.poll(async () => (await markerGeometry()).inView).toBe(true);
    geometry = await markerGeometry();
    expectNear(geometry.left, 0.688);
    expectNear(geometry.right, 0.912);

    // Turning to the other page and back, scrolled away, brings the same cell into view again once
    // its photo has loaded.
    await page.getByRole("button", { name: "Previous page", exact: true }).click();
    await expect(pageLabel).toHaveText("Page 1 of 2");
    await expect(marker).toHaveCount(0);
    await viewport.evaluate((el) => {
        el.scrollTop = 0;
        el.scrollLeft = 0;
    });
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(pageLabel).toHaveText("Page 2 of 2");
    await expect.poll(async () => (await markerGeometry()).inView).toBe(true);
});
