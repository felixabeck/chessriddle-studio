import type { Page } from "@playwright/test";
import catalog from "../src/catalogs/engines.json" with { type: "json" };
import { serializeStorageValue } from "../src/state/store/debouncedStorage";
import {
    assertNothingClipped,
    assertPageNotClipped,
    expect,
    test,
    type MockScenario,
} from "./fixtures";

const stockfish = catalog.find(
    (engine) => engine.name === "Stockfish" && engine.os === "linux" && !engine.bmi2,
)!;
const progressId = `engine:${stockfish.downloadLink}`;
const commands = {
    is_bmi2_compatible: { result: false },
    verify_signed_bytes: { result: null },
    get_progress: { result: null },
    prepare_download: { result: "first-stockfish-ticket" },
    release_download: { result: null },
    cancel_download: { result: true },
    clear_progress: { result: "8" },
    get_engine_workspace: {
        result: { root: { id: { id: "engine-root" }, kind: "engineRoot" }, displayName: "Engines" },
    },
    // Natural settlement is beyond the test's 45-second timeout. Only cancel ends this job.
    install_engine_workflow: {
        delay: 120_000,
        error: { tag: "backend-error", category: "cancellation", message: "Cancellation" },
    },
} satisfies NonNullable<MockScenario["commands"]>;

async function installCalls(page: Page) {
    return page.evaluate(
        () =>
            window.__E2E_TAURI__
                .invocations()
                .filter(({ command }) => command === "install_engine_workflow").length,
    );
}

async function assertNoAutomaticInstall(page: Page) {
    // Observe a bounded quiet interval after catalog loading has completed and the button exists.
    const observations = await page.evaluate(async () => {
        const samples = [];
        const deadline = Date.now() + 1000;
        do {
            samples.push({
                started: window.__E2E_TAURI__
                    .invocations()
                    .some(({ command }) => command === "install_engine_workflow"),
                marker: localStorage.getItem("first-launch-stockfish"),
            });
            await new Promise((resolve) => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        return samples;
    });
    expect(observations.every(({ started }) => !started)).toBe(true);
    return observations;
}

test.beforeEach(async ({ page, mockScenario }) => {
    await page.addInitScript(() =>
        Object.defineProperty(navigator, "webdriver", { get: () => false }),
    );
    await mockScenario({ commands });
});

test("automatic install stays visible across routes, cancels, and never starts again after reload", async ({
    page,
}) => {
    await page.goto("/");
    await expect.poll(() => installCalls(page)).toBe(1);
    const notice = page.getByRole("status").filter({ hasText: `Stockfish ${stockfish.version}` });
    await expect(notice).toBeVisible();
    await expect
        .poll(() =>
            page.evaluate(
                (id) =>
                    window.__E2E_TAURI__
                        .invocations()
                        .some(
                            ({ command, args }) =>
                                command === "get_progress" && (args as { id?: string }).id === id,
                        ),
                progressId,
            ),
        )
        .toBe(true);
    await assertPageNotClipped(page);
    await page.evaluate(
        (id) =>
            window.__E2E_TAURI__.emit("progress-event", {
                id,
                generation: "7",
                state: "running",
                progress: 37,
                finished: false,
                cleared: false,
            }),
        progressId,
    );
    await expect(notice.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "37");
    // The element clip includes the page behind the fixed notice along its fractional top edge
    // and rounded corners. Hiding that page keeps the snapshot about the notice alone.
    const hiddenPage = await page.addStyleTag({
        content: ".mantine-AppShell-main { visibility: hidden; }",
    });
    await expect(notice).toHaveScreenshot("automatic-stockfish-notice.png");
    await hiddenPage.evaluate((style) => style.remove());
    await page.getByRole("link", { name: "Engines", exact: true }).click();
    await expect(notice).toBeVisible();
    await expect(page.getByRole("button", { name: /Downloading/ })).toHaveCount(2);
    await expect(notice).toBeVisible();
    await notice.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect
        .poll(() =>
            page.evaluate(() =>
                window.__E2E_TAURI__
                    .invocations()
                    .filter(({ command }) => command === "cancel_download")
                    .map(({ args }) => args),
            ),
        )
        .toEqual([{ id: "first-stockfish-ticket" }]);
    await expect(notice).not.toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("alert").filter({ hasText: "Error" })).not.toBeVisible();
    const button = page.getByRole("button", { name: "Install Stockfish", exact: true });
    await expect(button).toBeEnabled();
    await assertNothingClipped(
        button.locator("xpath=ancestor::*[contains(@class,'mantine-Stack-root')][1]"),
    );
    await expect(button).toHaveScreenshot("engines-install-stockfish.png");
    const marker = await page.evaluate(() => localStorage.getItem("first-launch-stockfish"));
    expect(marker).not.toBeNull();
    await page.evaluate(() => sessionStorage.setItem("__E2E_PRESERVE_STORAGE_ONCE__", "1"));
    await page.reload();
    await expect(button).toBeVisible();
    const observations = await assertNoAutomaticInstall(page);
    expect(observations.every((sample) => sample.marker === marker)).toBe(true);
    await page.getByRole("link", { name: "Board", exact: true }).click();
    await page.getByRole("button", { name: /^analysis board$/i }).click();
    await page.getByRole("tab", { name: "Analysis", exact: true }).click();
    await page.getByRole("button", { name: "Select engines", exact: true }).click();
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
    await expect(button).toBeInViewport({ ratio: 1 });
    await assertNothingClipped(page.locator(".mantine-Popover-dropdown"));
    await expect(page.locator(".mantine-Popover-dropdown")).toHaveScreenshot(
        "analysis-install-stockfish.png",
    );
});

test("an existing engines key leaves the profile untouched and offers the fallback", async ({
    page,
}) => {
    await page.addInitScript(
        (engines) => localStorage.setItem("engines", engines),
        serializeStorageValue([]),
    );
    await page.goto("/engines");
    await expect(
        page.getByRole("button", { name: "Install Stockfish", exact: true }),
    ).toBeEnabled();
    const observations = await assertNoAutomaticInstall(page);
    expect(observations.every(({ marker }) => marker === null)).toBe(true);
    await expect(page.getByRole("status").filter({ hasText: "Stockfish" })).toHaveCount(0);
});
