import { defineConfig, devices } from "@playwright/test";

const chromium = devices["Desktop Chrome"];

/**
 * Each project owns one high-value journey.  Together they cover the required
 * viewport, colour-scheme, and app-font-scale matrix without multiplying every
 * interaction by all twelve combinations.
 */
export default defineConfig({
    testDir: "./e2e",
    timeout: 45_000,
    expect: { timeout: 8_000 },
    fullyParallel: true, // Five green runs at workers 6 on 2026-09-30 with no snapshot changes.
    forbidOnly: true,
    retries: 0,
    // The container runs outside the agent's memory scope (docker daemon cgroup), so these workers do
    // not consume its budget. Timings under load average 64-90 from other sessions (wall s):
    // 4=[53.79,47.60,52.58,54.28,50.29]; 6=[36.73,44.12,40.86,37.77,39.31,43.78,43.36]; 10=[38.86].
    workers: 6,
    reporter: [
        ["list"],
        ["html", { outputFolder: "artifacts/frontend-audit/html", open: "never" }],
    ],
    outputDir: "artifacts/frontend-audit/test-results",
    use: {
        baseURL: "http://127.0.0.1:4173",
        trace: "on",
        screenshot: "on",
        video: "off",
    },
    snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}-{projectName}{ext}",
    projects: [
        {
            name: "new-game-to-database",
            testMatch: /new-game-to-database\.spec\.ts/,
            use: { ...chromium, viewport: { width: 1280, height: 900 }, colorScheme: "light" },
        },
        {
            name: "game-references",
            testMatch: /game-references\.spec\.ts/,
            use: { ...chromium, viewport: { width: 800, height: 720 }, colorScheme: "light" },
        },
        {
            name: "game-interruption",
            testMatch: /game-interruption\.spec\.ts/,
            use: { ...chromium, viewport: { width: 1440, height: 900 }, colorScheme: "light" },
        },
        {
            name: "engine-gap",
            testMatch: /engine-gap\.spec\.ts/,
            use: { ...chromium, viewport: { width: 1440, height: 900 }, colorScheme: "light" },
        },
        {
            name: "chessdb-engine",
            testMatch: /chessdb-engine\.spec\.ts/,
            use: { ...chromium, viewport: { width: 1440, height: 900 }, colorScheme: "light" },
        },
        {
            name: "workspace-tabs",
            testMatch: /workspace-tabs\.spec\.ts/,
            use: { ...chromium, viewport: { width: 1440, height: 900 }, colorScheme: "light" },
        },
        {
            name: "board-keyboard",
            testMatch: /board-keyboard\.spec\.ts/,
            use: { ...chromium, viewport: { width: 800, height: 720 }, colorScheme: "dark" },
        },
        {
            name: "database-files",
            testMatch: /database-files\.spec\.ts/,
            use: { ...chromium, viewport: { width: 800, height: 720 }, colorScheme: "light" },
        },
        {
            name: "accounts-puzzles-engines",
            testMatch: /accounts-puzzles-engines\.spec\.ts/,
            use: { ...chromium, viewport: { width: 1440, height: 900 }, colorScheme: "dark" },
        },
        {
            name: "settings-responsive",
            testMatch: /settings-responsive\.spec\.ts/,
            use: { ...chromium, viewport: { width: 320, height: 720 }, colorScheme: "light" },
        },
        {
            name: "font-scaled-breakpoints",
            testMatch: /font-scaled-breakpoints\.spec\.ts/,
            use: { ...chromium, viewport: { width: 1000, height: 720 }, colorScheme: "light" },
        },
        {
            name: "async-errors",
            testMatch: /async-errors\.spec\.ts/,
            use: { ...chromium, viewport: { width: 320, height: 720 }, colorScheme: "dark" },
        },
        {
            name: "quit-gate",
            testMatch: /quit-gate\.spec\.ts/,
            use: { ...chromium, viewport: { width: 320, height: 720 }, colorScheme: "light" },
        },
        {
            name: "security-consent",
            testMatch: /security-consent\.spec\.ts/,
            use: { ...chromium, viewport: { width: 320, height: 720 }, colorScheme: "dark" },
        },
        {
            name: "file-freshness",
            testMatch: /file-freshness\.spec\.ts/,
            use: { ...chromium, viewport: { width: 800, height: 720 }, colorScheme: "light" },
        },
        {
            name: "files-preview",
            testMatch: /files-preview\.spec\.ts/,
            use: { ...chromium, viewport: { width: 1920, height: 760 }, colorScheme: "light" },
        },
        {
            name: "tree-recovery",
            testMatch: /tree-recovery\.spec\.ts/,
            use: { ...chromium, viewport: { width: 800, height: 720 }, colorScheme: "light" },
        },
        {
            name: "board-wood-texture",
            testMatch: /board-wood-texture\.spec\.ts/,
            use: { ...chromium, viewport: { width: 1280, height: 900 }, colorScheme: "light" },
        },
        {
            name: "piece-size",
            testMatch: /piece-size\.spec\.ts/,
            use: { ...chromium, viewport: { width: 1280, height: 900 }, colorScheme: "light" },
        },
        {
            name: "notation-hierarchy",
            testMatch: /notation-hierarchy\.spec\.ts/,
            grepInvert: /overflow-only/,
            use: { ...chromium, viewport: { width: 1280, height: 900 }, colorScheme: "light" },
        },
        {
            name: "notation-hierarchy-scaled",
            testMatch: /notation-hierarchy\.spec\.ts/,
            grep: /overflow-only/,
            // 200% font at 720px height leaves the notation without rows (f-20261101-32), hence the taller window.
            use: { ...chromium, viewport: { width: 1000, height: 1100 }, colorScheme: "light" },
        },
    ],
    webServer: {
        // Invoked through node_modules/.bin rather than `pnpm exec`, so the suite runs
        // unchanged inside the pinned Playwright image, which has no pnpm.
        command:
            "node_modules/.bin/vite build && node_modules/.bin/vite preview --host 127.0.0.1 --port 4173 --strictPort",
        url: "http://127.0.0.1:4173",
        reuseExistingServer: false,
        timeout: 120_000,
    },
});
