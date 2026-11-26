import { expect, test, waitForTransitionsSettled } from "./fixtures";
import { importFromPhoto, scoresheetPhotoCommands } from "./scoresheetPhotoImport";

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
            coach_connections: { result: [connection] },
            coach_models: { result: models },
            scoresheet_pick_photos: {
                result: { photos: [{ dataUrl: PHOTO_DATA_URL }], skipped: 0, failed: 0 },
            },
            // Held long enough that the whole progress state can be inspected.
            scoresheet_read: { result: stubGame, delay: 600_000 },
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
