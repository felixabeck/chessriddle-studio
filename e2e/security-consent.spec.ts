import { assertPageNotClipped, expect, test } from "./fixtures";

test("security-consent: keeps storage free of credential fields and sends no telemetry", async ({
    page,
    assertAccessible,
    assertNoHorizontalOverflow,
    capture,
}) => {
    let telemetryRequests = 0;
    await page.route(/https:\/\/(?:app|us\.i|us-assets\.i)\.posthog\.com\/.*/, async (route) => {
        telemetryRequests += 1;
        await route.abort();
    });
    await page.goto("/settings");

    await expect(page.getByRole("tab", { name: /privacy/i })).toHaveCount(0);
    await expect(page.getByRole("switch", { name: /telemetry|analytics/i })).toHaveCount(0);
    await expect
        .poll(() => page.evaluate(() => JSON.stringify({ localStorage, sessionStorage })))
        .not.toContain("accessToken");
    expect(telemetryRequests).toBe(0);

    await expect(page.getByRole("tabpanel", { name: /board/i })).toBeVisible();
    await assertAccessible();

    await page.getByRole("tab", { name: /appearance/i }).click();
    await assertNoHorizontalOverflow();
    await assertPageNotClipped(page);
    await assertAccessible();
    await capture("security-consent");
    await expect(page).toHaveScreenshot("security-consent.png", { fullPage: true });
});
