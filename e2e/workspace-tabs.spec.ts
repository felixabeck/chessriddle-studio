import {
    expect,
    filesWorkspaceCommands,
    filesWorkspaceFixture,
    pgnFileCommands,
    preserveStorageForReload,
    selectFilesTreeRow,
    test,
    gameOpeningCommands,
    gameOpeningFixture,
    dragMosaicDivider,
    activeWorkspaceTab,
    playBoardMove,
    assertNothingClipped,
} from "./fixtures";
import { deserializeStorageValue } from "../src/state/store/debouncedStorage";
import { createEmptyCard } from "ts-fsrs";

test("workspace-tabs: home fills remaining height with reachable recent and due lists", async ({
    page,
    mockScenario,
}, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const recents: unknown[] = Array.from({ length: 10 }, (_, i) => ({
        name: `Recent ${i + 1}`,
        handle: { id: { id: `home-${i}` }, kind: "fileWorkspace" },
        type: i % 3 === 0 ? "repertoire" : "game",
        lastOpened: Date.UTC(2026, 9, 31 - i),
    }));
    recents[1] = {
        kind: "database",
        name: "White - Black",
        database: { id: { id: "home-db" }, kind: "database" },
        gameId: 42,
        databaseTitle: "Meine Partien",
        lastOpened: (recents[1] as { lastOpened: number }).lastOpened,
    };
    await page.addInitScript(
        (stored) => localStorage.setItem("recent-files", stored),
        JSON.stringify(recents),
    );
    await mockScenario({
        commands: {
            count_pgn_games: { result: 1 },
            get_db_game: {
                error: {
                    tag: "backend-error",
                    category: "database",
                    message: "Database unavailable",
                },
            },
            load_practice_deck: {
                result: {
                    positionsDocument: JSON.stringify({
                        positions: [
                            {
                                fen: "start",
                                answer: "e4",
                                card: createEmptyCard(),
                            },
                        ],
                    }),
                    revision: 1,
                    generation: 0,
                    migrated: true,
                    unappliedReviews: 0,
                    orphansAcknowledged: true,
                },
            },
        },
    });
    await page.goto("/");
    const recent = page.locator("[data-home-recents]");
    const due = page.locator("[data-home-due]");
    const viewport = recent.locator(".mantine-ScrollArea-viewport");
    const rows = recent.locator("[data-recent-file]");
    await expect(rows).toHaveCount(10);
    await expect(due.locator("[data-due-file]")).toHaveCount(4);
    const card = (await recent.boundingBox())!;
    const dueBox = (await due.boundingBox())!;
    const list = (await viewport.boundingBox())!;
    const title = (await recent.locator("[data-home-title]").boundingBox())!;
    const cardBottomPadding = 17;
    const titleGap = 10;
    const layoutTolerance = 8;
    expect(list.height, "recent list exceeds the old 300px cap").toBeGreaterThan(300);
    expect(
        Math.abs(list.y + list.height - (card.y + card.height - cardBottomPadding)),
    ).toBeLessThan(layoutTolerance);
    expect(Math.abs(list.y - (title.y + title.height + titleGap))).toBeLessThan(layoutTolerance);
    expect(Math.abs(card.y + card.height - 1000)).toBeLessThan(32);
    expect(Math.abs(dueBox.y + dueBox.height - 1000)).toBeLessThan(32);
    expect(Math.abs(card.y - dueBox.y)).toBeLessThan(2);
    expect(dueBox.x).toBeGreaterThan(card.x + card.width);
    for (let i = 0; i < 10; i++) {
        await rows.nth(i).scrollIntoViewIfNeeded();
        const box = (await rows.nth(i).boundingBox())!;
        const visible = (await viewport.boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(visible.y - 1);
        expect(box.y + box.height).toBeLessThanOrEqual(visible.y + visible.height + 1);
    }
    await testInfo.attach("home-desktop.png", {
        body: await page.screenshot(),
        contentType: "image/png",
    });
    await page.setViewportSize({ width: 600, height: 500 });
    const narrowRecent = (await recent.boundingBox())!;
    const narrowDue = (await due.boundingBox())!;
    expect(narrowDue.y).toBeGreaterThan(narrowRecent.y + narrowRecent.height);
    await rows.last().scrollIntoViewIfNeeded();
    await expect(rows.last()).toBeInViewport();
    await due.scrollIntoViewIfNeeded();
    await expect(due).toBeInViewport();
    await expect(
        due.getByRole("button", { name: "Practice", exact: true }).last(),
    ).toBeInViewport();
    await testInfo.attach("home-narrow.png", {
        body: await page.screenshot(),
        contentType: "image/png",
    });
});

for (const { count, linked } of [
    { count: 0, linked: false },
    { count: 3, linked: false },
    { count: 3, linked: true },
]) {
    test(`workspace-tabs: fresh first save appends at destination count ${count}${linked ? " in a linked collection" : ""}`, async ({
        page,
        mockScenario,
        capture,
    }) => {
        if (linked) {
            await page.addInitScript(() =>
                localStorage.setItem("auto-save", JSON.stringify(false)),
            );
        }
        const handle = { id: { id: "first-save-destination" }, kind: "fileWorkspace" } as const;
        const revision = "first-save-revision";
        const locator = {
            collection: "22222222-2222-4222-8222-222222222222",
            generation: revision,
            ordinal: count,
            stamp: "a".repeat(64),
        };
        await mockScenario({
            commands: {
                issue_pgn_export_destination: {
                    result: { handle, displayName: "First save.pgn", availability: "available" },
                },
                count_pgn_games: { result: count },
                write_game: {
                    result: {
                        stamp: "a".repeat(64),
                        revision,
                        ...(linked ? { linked: locator } : {}),
                    },
                },
                file_revision: { result: revision },
            },
        });
        await page.goto("/");
        await page.getByRole("button", { name: /^open$/i }).click();
        const before = (await activeWorkspaceTab(page))!;
        expect(before.gameOrigin).toEqual({ kind: "none" });
        const board = page.getByRole("grid", {
            name: "Chessboard, White orientation",
            exact: true,
        });
        await expect(board).toBeVisible();
        await playBoardMove(page, page.locator("cg-board").first(), "e2", "e4");
        await playBoardMove(page, page.locator("cg-board").first(), "e7", "e5");
        await page.getByRole("tab", { name: "Annotate", exact: true }).click();
        const comment = "First saved analysis comment";
        await page.locator('[contenteditable="true"]').fill(comment);
        await page.getByRole("button", { name: /^save pgn/i }).click();
        await expect(page.locator("[data-file-freshness]")).toHaveAttribute(
            "data-file-freshness",
            /^verified:/,
        );
        const after = (await activeWorkspaceTab(page))!;
        expect(after.value).toBe(before.value);
        expect(after.treeKey).toBe(before.treeKey);
        expect(after.gameOrigin).toMatchObject({
            kind: "file",
            gameNumber: count,
            file: { handle, numGames: count + 1, name: "First save" },
        });
        const calls = await page.evaluate(() => window.__E2E_TAURI__.invocations());
        expect(
            calls.filter(({ command }) => command === "issue_pgn_export_destination"),
        ).toHaveLength(1);
        expect(calls.filter(({ command }) => command === "issue_pgn_workspace")).toHaveLength(0);
        expect(calls.filter(({ command }) => command === "count_pgn_games")).toMatchObject([
            { command: "count_pgn_games", args: { file: handle } },
        ]);
        const writes = calls.filter(({ command }) => command === "write_game");
        expect(writes).toHaveLength(1);
        expect(writes[0].args).toMatchObject({
            file: handle,
            n: count,
            expected: { kind: "append" },
            pgn: expect.stringContaining("1. e4 e5"),
        });
        expect(writes[0].args).toMatchObject({ pgn: expect.stringContaining(comment) });
        expect(calls.filter(({ command }) => command === "read_game")).toHaveLength(0);
        await expect(board).toBeVisible();
        await expect(
            page.getByRole("gridcell", { name: "e4, White Pawn", exact: true }),
        ).toHaveCount(1);
        await expect(
            page.getByRole("gridcell", { name: "e5, Black Pawn", exact: true }),
        ).toHaveCount(1);
        await expect(page.locator('[contenteditable="true"]')).toHaveText(comment);
        if (linked) {
            await expect
                .poll(async () => {
                    const raw = await page.evaluate(
                        (key) => sessionStorage.getItem(key),
                        after.treeKey ?? after.value,
                    );
                    return raw
                        ? deserializeStorageValue<{ state: { linkedSource: unknown } }>(raw)?.state
                              .linkedSource
                        : undefined;
                })
                .toEqual(locator);
            await page.locator('[contenteditable="true"]').fill("A later linked edit");
            await page.getByRole("button", { name: /^save pgn/i }).click();
            await expect
                .poll(() =>
                    page.evaluate(
                        () =>
                            window.__E2E_TAURI__
                                .invocations()
                                .filter(({ command }) => command === "write_game").length,
                    ),
                )
                .toBe(2);
            const later = await page.evaluate(() =>
                window.__E2E_TAURI__
                    .invocations()
                    .filter(({ command }) => command === "write_game")
                    .at(-1),
            );
            expect(later?.args).toMatchObject({
                expected: { kind: "linkedGame", stamp: locator.stamp, revision },
            });
        }
        await capture(`workspace-tabs-first-save-${count}${linked ? "-linked" : ""}`);
    });
}

test("workspace-tabs: analysis row and nested column drags resize panes and restore committed percentages", async ({
    page,
    mockScenario,
}) => {
    await mockScenario({
        commands: filesWorkspaceCommands([[gameOpeningFixture.file]], gameOpeningCommands),
    });
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose collection", exact: true }).click();
    await selectFilesTreeRow(page, gameOpeningFixture.file.name);
    await page.getByRole("button", { name: "Open game", exact: true }).click();
    const mosaic = page.locator(".mosaic-root");
    const left = page.locator(".mosaic-tile:has(> #left)");
    const top = page.locator(".mosaic-tile:has(> #topRight)");
    const bottom = page.locator(".mosaic-tile:has(> #bottomRight)");
    const beforeLeft = (await left.boundingBox())!.width;
    const beforeTop = (await top.boundingBox())!.height;
    const beforeBottom = (await bottom.boundingBox())!.height;
    for (const [direction, ratio] of [
        ["row", 60],
        ["column", 65],
    ] as const) {
        await dragMosaicDivider(page, {
            root: mosaic,
            split: mosaic.locator(`.mosaic-split.-${direction}`),
            percentage: ratio,
            direction,
            crossAxisRatio: direction === "row" ? 0.25 : 0.75,
        });
    }
    const percentages = () =>
        page.evaluate(() => {
            const node = JSON.parse(localStorage.getItem("windowsState")!).currentNode;
            return { row: node.splitPercentage, column: node.second.splitPercentage };
        });
    await expect.poll(async () => Math.abs((await percentages()).row - 60)).toBeLessThan(0.5);
    await expect.poll(async () => Math.abs((await percentages()).column - 65)).toBeLessThan(0.5);
    const committed = await percentages();
    expect((await left.boundingBox())!.width).toBeGreaterThan(beforeLeft);
    expect((await top.boundingBox())!.height).toBeGreaterThan(beforeTop);
    expect((await bottom.boundingBox())!.height).toBeLessThan(beforeBottom);
    const dimensions = [
        await left.boundingBox(),
        await top.boundingBox(),
        await bottom.boundingBox(),
    ];
    await preserveStorageForReload(page);
    await expect.poll(percentages).toEqual(committed);
    await expect
        .poll(async () => [
            await left.boundingBox(),
            await top.boundingBox(),
            await bottom.boundingBox(),
        ])
        .toEqual(dimensions);
});

test("workspace-tabs: closing the last tab of an opened repertoire file leaves a New Tab", async ({
    page,
    mockScenario,
}) => {
    const repertoireFile = {
        ...filesWorkspaceFixture.pgnFile,
        metadata: { type: "repertoire" as const, tags: [] },
    };
    await mockScenario({
        commands: filesWorkspaceCommands([[repertoireFile]], { ...pgnFileCommands }),
    });
    await page.goto("/library");
    await page.getByRole("button", { name: /choose collection/i }).click();
    await selectFilesTreeRow(page, repertoireFile.name);
    await page.getByRole("button", { name: "Open game", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    // Train is an inner tab rendered by PracticePanel, proving its cleanup has mounted.
    await expect(page.getByRole("tab", { name: "Train", exact: true })).toBeVisible();
    await page.getByRole("button", { name: /close tab/i }).click();
    await expect(page.getByText(/an error occurred/i)).toHaveCount(0);
    const workspaceTabs = page.getByRole("tablist").first().getByRole("tab");
    await expect(workspaceTabs).toHaveCount(1);
    await expect(workspaceTabs).toHaveText("New Tab");
    await expect(workspaceTabs).toHaveAttribute("aria-selected", "true");
});

for (const surface of [
    { name: "desktop", width: 1440, scale: "100" },
    { name: "320-200", width: 320, scale: "200" },
]) {
    test(`workspace-tabs: repertoire coverage failure stays unknown and explicit Retry recovers at ${surface.name}`, async ({
        page,
        mockScenario,
        assertNoHorizontalOverflow,
    }, testInfo) => {
        const clockStart = new Date("2026-10-21T00:00:00Z");
        await page.clock.install({ time: clockStart });
        await page.clock.pauseAt(clockStart.getTime() + 1000);
        await page.setViewportSize({ width: surface.width, height: 1000 });
        const database = { id: { id: "coverage-reference" }, kind: "database" } as const;
        await page.addInitScript(
            ({ scale, database }) => {
                localStorage.setItem("font-size", scale);
                localStorage.setItem("reference-database", JSON.stringify(database));
                localStorage.setItem("auto-save", "false");
                if (scale === "200") {
                    // Use the supported focused practice pane at the compact font-scaled size.
                    localStorage.setItem(
                        "windowsState",
                        JSON.stringify({ currentNode: "topRight" }),
                    );
                }
            },
            { scale: surface.scale, database },
        );
        const repertoireFile = {
            ...filesWorkspaceFixture.pgnFile,
            metadata: { type: "repertoire" as const, tags: [] },
        };
        const stats = (move: string) => [[{ move, white: 100, draw: 0, black: 0 }], []];
        await mockScenario({
            commands: filesWorkspaceCommands([[repertoireFile]], {
                ...pgnFileCommands,
                collection_for_database: {
                    result: {
                        id: "22222222-2222-4222-8222-222222222222",
                        name: "Coverage reference",
                        file: { id: { id: "coverage-source" }, kind: "fileWorkspace" },
                        database,
                        status: "ready",
                        generation: "ready-coverage-generation",
                        omitted: 0,
                        account: null,
                        retiredDatabase: null,
                        fetchSinceMs: null,
                    },
                },
                search_position: {
                    outcomes: [
                        // Ready-reference cache reset cancels the first position read before IPC.
                        // Coverage's root read and the replacement position read both succeed.
                        { result: stats("e4") },
                        { result: stats("e4") },
                        { result: stats("c5") },
                        { result: [[], []] },
                        // A stable annotation edit then fails coverage's new root read.
                        {
                            error: {
                                tag: "backend-error",
                                category: "database",
                                message: "Repertoire coverage query failed",
                            },
                        },
                        // Retry covers the actual root, e4 and c5 nodes from pgnFileCommands.
                        { result: stats("e4") },
                        { result: stats("c5") },
                        { result: [[], []] },
                    ],
                    result: [[], []],
                },
            }),
        });
        await page.goto("/library");
        await expect(page.locator("html")).toHaveCSS(
            "font-size",
            surface.scale === "200" ? "32px" : "16px",
        );
        await page.getByRole("button", { name: "Choose collection", exact: true }).click();
        await selectFilesTreeRow(page, repertoireFile.name);
        await page.getByRole("button", { name: "Open game", exact: true }).click();
        await page.getByRole("tab", { name: "Build", exact: true }).click();
        const build = page.getByRole("tabpanel", { name: "Build", exact: true });
        const completeness = build.getByText("No gaps found — your repertoire is complete!", {
            exact: true,
        });
        const prepared = build.getByRole("button", { name: /1\. e4/ });
        const queries = () =>
            page.evaluate(() =>
                window.__E2E_TAURI__
                    .invocations()
                    .filter(({ command }) => command === "search_position"),
            );
        await expect(completeness).toBeVisible();
        await expect(prepared.getByRole("progressbar").last()).toHaveAttribute(
            "aria-valuenow",
            "100",
        );
        expect(await queries()).toHaveLength(4);
        const tab = (await activeWorkspaceTab(page))!;
        // BoardAnalysis's existing good-move hotkey edits the current tree without changing FEN,
        // reference metadata, position-cache ownership or the mounted Practice/Build panel.
        await page.keyboard.press("2");
        await page.clock.runFor(300);
        const raw = await page.evaluate(
            (key) => sessionStorage.getItem(key),
            tab.treeKey ?? tab.value,
        );
        expect(raw).not.toBeNull();
        expect(deserializeStorageValue(raw!)).toMatchObject({
            state: { dirty: true, root: { nags: [1] } },
        });
        const error = build.getByRole("alert");
        const retry = error.getByRole("button", { name: "Retry", exact: true });
        await retry.scrollIntoViewIfNeeded();
        await testInfo.attach(`repertoire-retry-geometry-${surface.name}.json`, {
            body: JSON.stringify(
                await retry.evaluate((element) => {
                    const ancestors = [];
                    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
                        const style = getComputedStyle(node);
                        ancestors.push({
                            tag: node.tagName,
                            className: node.className,
                            rect: node.getBoundingClientRect().toJSON(),
                            clientWidth: node.clientWidth,
                            clientHeight: node.clientHeight,
                            scrollWidth: node.scrollWidth,
                            scrollHeight: node.scrollHeight,
                            scrollLeft: node.scrollLeft,
                            scrollTop: node.scrollTop,
                            overflowX: style.overflowX,
                            overflowY: style.overflowY,
                            padding: style.padding,
                            border: style.borderWidth,
                        });
                    }
                    return { viewport: { width: innerWidth, height: innerHeight }, ancestors };
                }),
                null,
                2,
            ),
            contentType: "application/json",
        });
        await expect(retry).toBeInViewport({ ratio: 1 });
        await expect(error).toContainText("Error");
        await expect(completeness).toHaveCount(0);
        await expect(build.getByRole("button", { name: /Next gap|Biggest gap/i })).toHaveCount(0);
        await expect(prepared).toBeVisible();
        await expect(prepared).toContainText("100");
        await expect(prepared.getByRole("progressbar")).toHaveCount(3);
        await assertNothingClipped(error, { mode: "reachable" });
        await assertNoHorizontalOverflow();
        expect(await queries()).toHaveLength(5);
        const failedAt = await page.evaluate(() => Date.now());
        await page.clock.runFor(2000);
        expect(await page.evaluate(() => Date.now())).toBe(failedAt + 2000);
        expect(await queries()).toHaveLength(5);
        await expect(retry).toBeVisible();
        const coverageNotification = page
            .locator(".mantine-Notification-root")
            .filter({ hasText: "Repertoire coverage query failed" });
        await expect(coverageNotification).toHaveCount(1);
        await expect(coverageNotification).toBeVisible();
        await coverageNotification.locator(".mantine-Notification-closeButton").click();
        await page.clock.resume();
        await expect(coverageNotification).toHaveCount(0);
        await retry.scrollIntoViewIfNeeded();
        await expect(retry).toBeInViewport({ ratio: 1 });
        await testInfo.attach(`repertoire-coverage-error-${surface.name}.png`, {
            body: await page.screenshot({ fullPage: true }),
            contentType: "image/png",
        });

        await retry.click();
        await expect(completeness).toBeVisible();
        await expect(error).toHaveCount(0);
        await expect(build.getByText("Loading position data...", { exact: true })).toHaveCount(0);
        await expect(prepared.getByRole("progressbar")).toHaveCount(4);
        await expect(prepared.getByRole("progressbar").last()).toHaveAttribute(
            "aria-valuenow",
            "100",
        );
        const calls = await queries();
        expect(calls).toHaveLength(8);
        expect(
            calls.map(
                ({ args }) => (args as { query: { position: { fen: string } } }).query.position.fen,
            ),
        ).toEqual([
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -",
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -",
            "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -",
            "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -",
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -",
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -",
            "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -",
            "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -",
        ]);
        await completeness.scrollIntoViewIfNeeded();
        await expect(completeness).toBeInViewport({ ratio: 1 });
        await assertNothingClipped(completeness, { mode: "reachable" });
        await assertNoHorizontalOverflow();
        await testInfo.attach(`repertoire-coverage-recovered-${surface.name}.png`, {
            body: await page.screenshot({ fullPage: true }),
            contentType: "image/png",
        });
    });
}

function practiceFeedbackSetup(now: Date) {
    const repertoireFile = {
        ...filesWorkspaceFixture.pgnFile,
        metadata: { type: "repertoire" as const, tags: [] },
    };
    const pgn =
        '[Event "Practice feedback"]\n[White "Weiss"]\n[Black "Schwarz"]\n[Result "*"]\n\n1. e4 e5 2. Nf3 *';
    const game = {
        pgn,
        stamp: "c".repeat(64),
        revision: "practice-feedback-revision",
        present: true,
    };
    const cardFen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
    const commands = filesWorkspaceCommands([[repertoireFile]], {
        ...pgnFileCommands,
        read_games: { result: [game] },
        read_game: { result: game },
        file_revision: { result: game.revision },
        lex_pgn: {
            result: [
                { type: "Header", value: { tag: "Event", value: "Practice feedback" } },
                { type: "Header", value: { tag: "White", value: "Weiss" } },
                { type: "Header", value: { tag: "Black", value: "Schwarz" } },
                { type: "Header", value: { tag: "Result", value: "*" } },
                { type: "San", value: "e4" },
                { type: "San", value: "e5" },
                { type: "San", value: "Nf3" },
                { type: "Outcome", value: "*" },
            ],
        },
        load_practice_deck: {
            result: {
                positionsDocument: JSON.stringify({
                    positions: [{ fen: cardFen, answer: "Nf3", card: createEmptyCard(now) }],
                }),
                revision: 1,
                generation: 0,
                migrated: false,
                unappliedReviews: 0,
                orphansAcknowledged: true,
            },
        },
        record_practice_review: { result: 2 },
    });
    return { repertoireFile, pgn, game, cardFen, commands };
}

test("workspace-tabs: Train reaches Start Practice by wheel, focus, and pointer at 800×647", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
}, testInfo) => {
    const now = new Date("2026-10-21T12:00:00Z");
    await page.clock.install({ time: now });
    await page.setViewportSize({ width: 800, height: 647 });
    await page.addInitScript(() => localStorage.setItem("auto-save", "false"));
    const { repertoireFile, commands } = practiceFeedbackSetup(now);
    await mockScenario({ commands });
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose collection", exact: true }).click();
    await selectFilesTreeRow(page, repertoireFile.name);
    await page.getByRole("button", { name: "Open game", exact: true }).click();
    const train = page.getByRole("tabpanel", { name: "Train", exact: true });
    const start = train.getByRole("button", { name: /Start Practice/ });
    const geometry = () =>
        start.evaluate((button) => {
            const panel = button.closest<HTMLElement>('[role="tabpanel"]')!;
            const panelBox = panel.getBoundingClientRect();
            const buttonBox = button.getBoundingClientRect();
            const top = panelBox.top + panel.clientTop;
            const bottom = top + panel.clientHeight;
            return {
                clientHeight: panel.clientHeight,
                scrollHeight: panel.scrollHeight,
                scrollTop: panel.scrollTop,
                top,
                bottom,
                buttonTop: buttonBox.top,
                buttonBottom: buttonBox.bottom,
                inside: buttonBox.top >= top && buttonBox.bottom <= bottom,
            };
        });
    const measure = async (stage: string) => {
        const result = await geometry();
        console.log(`Train ${stage}: ${JSON.stringify(result)}`);
        await testInfo.attach(`train-${stage}.json`, {
            body: JSON.stringify(result, null, 2),
            contentType: "application/json",
        });
        return result;
    };
    const expectInitiallyClipped = async () => {
        await expect(start).toBeEnabled();
        const initial = await measure("initial");
        expect(initial.scrollTop).toBe(0);
        expect(
            initial.buttonBottom,
            "Start Practice must initially extend below Train",
        ).toBeGreaterThan(initial.bottom);
        expect(initial.scrollHeight).toBeGreaterThan(initial.clientHeight);
    };
    const wheelToStart = async (stage: string) => {
        const box = (await train.boundingBox())!;
        const before = await geometry();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, 100);
        await expect.soft
            .poll(async () => (await geometry()).scrollTop, {
                message: `${stage}: wheel must scroll Train`,
                timeout: 1500,
            })
            .toBeGreaterThan(before.scrollTop);
        await expect.soft
            .poll(async () => (await geometry()).inside, {
                message: `${stage}: wheel must reveal all of Start Practice`,
                timeout: 1500,
            })
            .toBe(true);
        await measure(stage);
    };

    await expectInitiallyClipped();
    await wheelToStart("wheel");

    // Reload the unchanged default mosaic so wheel scrolling cannot help keyboard focus.
    await preserveStorageForReload(page);
    await page.getByRole("tab", { name: "Practice", exact: true }).click();
    await expectInitiallyClipped();
    await page.getByRole("tab", { name: "Train", exact: true }).focus();
    for (let tabs = 0; tabs < 30; tabs++) {
        await page.keyboard.press("Tab");
        if (await start.evaluate((button) => button === document.activeElement)) break;
    }
    await expect(start).toBeFocused();
    await expect.soft
        .poll(async () => (await geometry()).inside, {
            message: "keyboard focus must reveal all of Start Practice",
            timeout: 1500,
        })
        .toBe(true);
    await measure("focus");

    const mosaic = page.locator(".mosaic-root");
    const resize = async (percentage: number) =>
        dragMosaicDivider(page, {
            root: mosaic,
            split: mosaic.locator(".mosaic-split.-column"),
            percentage,
            direction: "column",
            crossAxisRatio: 0.75,
        });
    // Reset only after measuring wheel and focus, then establish the resize control case.
    await train.evaluate((panel) => {
        panel.scrollTop = 0;
    });
    await resize(80);
    await expect.poll(async () => (await geometry()).inside).toBe(true);
    expect((await measure("tall")).scrollTop).toBe(0);
    await resize(50);
    const restored = await measure("restored");
    expect(restored.scrollTop).toBe(0);
    expect(restored.buttonBottom).toBeGreaterThan(restored.bottom);
    expect(restored.scrollHeight).toBeGreaterThan(restored.clientHeight);
    await wheelToStart("restored-wheel");
    await assertNoHorizontalOverflow();
    await assertNothingClipped(start, { mode: "reachable" });

    const point = await start.evaluate((button) => {
        const box = button.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        return { x, y, hitsButton: button.contains(document.elementFromPoint(x, y)) };
    });
    expect(point.hitsButton, "visible button center must hit Start Practice").toBe(true);
    await page.mouse.click(point.x, point.y);
    await expect(train.getByText("Make your move on the board...", { exact: true })).toBeVisible();
    const board = page.getByRole("grid", { name: "Chessboard, White orientation", exact: true });
    await expect(board).toBeVisible();
    await expect(board.getByRole("gridcell", { name: "e5, Black Pawn", exact: true })).toHaveCount(
        1,
    );
    await assertNoHorizontalOverflow();
});

test("workspace-tabs: incorrect practice reveals the existing answer and its review log names the completed move", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
}, testInfo) => {
    const now = new Date("2026-10-21T12:00:00Z");
    await page.clock.install({ time: now });
    await page.clock.pauseAt(now.getTime() + 1000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript(() => localStorage.setItem("auto-save", "false"));
    const { repertoireFile, game, cardFen, commands } = practiceFeedbackSetup(now);
    await mockScenario({ commands });
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose collection", exact: true }).click();
    await selectFilesTreeRow(page, repertoireFile.name);
    await page.getByRole("button", { name: "Open game", exact: true }).click();
    const start = page.getByRole("button", { name: /Start Practice/ });
    await expect(start).toBeEnabled();
    await start.click();
    const board = page.getByRole("grid", { name: "Chessboard, White orientation", exact: true });
    await expect(board).toBeVisible();
    await expect(board.getByRole("gridcell", { name: "e5, Black Pawn", exact: true })).toHaveCount(
        1,
    );
    const tab = (await activeWorkspaceTab(page))!;
    const storedTree = async () => {
        const raw = await page.evaluate(
            (key) => sessionStorage.getItem(key),
            tab.treeKey ?? tab.value,
        );
        expect(raw).not.toBeNull();
        return deserializeStorageValue<{
            state: {
                root: unknown;
                headers: unknown;
                position: number[];
                practicePath: number[];
                dirty: boolean;
                sourceStamp: string;
            };
        }>(raw!)!.state;
    };
    // Ordinary forward navigation remains bounded at the active card, before its answer.
    await page.keyboard.press("ArrowRight");
    await page.clock.runFor(300);
    const before = await storedTree();
    expect(before).toMatchObject({
        position: [0, 0],
        practicePath: [0, 0],
        dirty: false,
        sourceStamp: game.stamp,
    });
    await playBoardMove(page, page.locator("cg-board").first(), "b1", "c3");
    await page.clock.runFor(1);
    await expect(page.getByText("The correct move was Nf3", { exact: true })).toBeVisible();
    await page.clock.runFor(499);
    expect((await storedTree()).position).toEqual([0, 0]);
    await expect(
        board.getByRole("gridcell", { name: "f3, White Knight", exact: true }),
    ).toHaveCount(0);
    await page.clock.runFor(1);
    await expect(
        board.getByRole("gridcell", { name: "f3, White Knight", exact: true }),
    ).toHaveCount(1);
    await page.clock.runFor(300);
    const after = await storedTree();
    expect(after).toMatchObject({
        position: [0, 0, 0],
        practicePath: [0, 0],
        dirty: false,
        sourceStamp: game.stamp,
    });
    expect(after.root).toEqual(before.root);
    expect(after.headers).toEqual(before.headers);
    const calls = await page.evaluate(() => window.__E2E_TAURI__.invocations());
    expect(calls.filter(({ command }) => command === "sync_practice_positions")).toHaveLength(0);
    expect(calls.filter(({ command }) => command === "write_game")).toHaveLength(0);
    const writes = calls.filter(({ command }) => command === "record_practice_review");
    expect(writes).toHaveLength(1);
    const review = writes[0].args as {
        fileId: string;
        game: number;
        generation: number;
        revision: number;
        baseRevision: number;
        entry: string;
        entryId: string;
        positionsDocument: string;
    };
    expect(review).toMatchObject({
        fileId: repertoireFile.handle.id.id,
        game: 0,
        generation: 0,
        revision: 1,
        baseRevision: 1,
    });
    expect(JSON.parse(review.entry)).toMatchObject({ fen: cardFen, rating: 1 });
    expect(JSON.parse(review.positionsDocument).positions).toHaveLength(1);
    expect(JSON.parse(review.positionsDocument).positions[0]).toMatchObject({
        fen: cardFen,
        answer: "Nf3",
    });
    await testInfo.attach("practice-existing-answer-revealed.png", {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
    });
    // Let the measured practice flow finish before the history modal's ordinary transition.
    await page.clock.resume();
    // The native history response returns the actual entry and ID produced by the rating path.
    await page.evaluate(
        ({ commands, entry }) =>
            window.__E2E_TAURI__.configure({
                commands: {
                    ...commands,
                    load_practice_reviews: { result: { entries: [entry], nextCursor: null } },
                },
            }),
        { commands, entry: { id: review.entryId, entry: review.entry } },
    );
    await page.getByRole("button", { name: "Show logs", exact: true }).click();
    const log = page.locator(`[data-practice-entry-id="${review.entryId}"]`);
    await expect(log.getByText("1... e5", { exact: true })).toBeVisible();
    await expect(log.getByText("2. e5", { exact: true })).toHaveCount(0);
    await assertNothingClipped(log, { mode: "reachable" });
    await assertNoHorizontalOverflow();
    await testInfo.attach("practice-completed-move-review-log.png", {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
    });
});

test("workspace-tabs: successful Italian marked-start coverage with a missing continuation stays incomplete and preparation recovers", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
}, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const database = { id: { id: "italian-reference" }, kind: "database" } as const;
    await page.addInitScript((reference) => {
        localStorage.setItem("reference-database", JSON.stringify(reference));
        localStorage.setItem("coverage-min-games", "10");
        localStorage.setItem("auto-save", "false");
    }, database);
    const repertoireFile = {
        ...filesWorkspaceFixture.pgnFile,
        metadata: { type: "repertoire" as const, tags: [] },
    };
    const game = {
        pgn: '[Event "Italian start"]\n[Result "*"]\n\n*',
        stamp: "d".repeat(64),
        revision: "italian-start",
        present: true,
    };
    const stats = (move: string) => [[{ move, white: 100, draw: 0, black: 0 }], []];
    const commands = filesWorkspaceCommands([[repertoireFile]], {
        ...pgnFileCommands,
        read_game: { result: game },
        read_games: { result: [game] },
        file_revision: { result: game.revision },
        lex_pgn: {
            result: [
                { type: "Header", value: { tag: "Event", value: "Italian start" } },
                { type: "Header", value: { tag: "Result", value: "*" } },
                { type: "Outcome", value: "*" },
            ],
        },
        collection_for_database: { result: null },
        search_position: { result: [[], []] },
    });
    await mockScenario({ commands });
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose collection", exact: true }).click();
    await selectFilesTreeRow(page, repertoireFile.name);
    await page.getByRole("button", { name: "Open game", exact: true }).click();
    await page.getByRole("tab", { name: "Build", exact: true }).click();
    const build = page.getByRole("tabpanel", { name: "Build", exact: true });
    const complete = build.getByText("No gaps found — your repertoire is complete!", {
        exact: true,
    });
    const queries = () =>
        page.evaluate(() =>
            window.__E2E_TAURI__
                .invocations()
                .filter(({ command }) => command === "search_position"),
        );
    await expect(
        build.getByText("No moves found in the reference database for this position.", {
            exact: true,
        }),
    ).toBeVisible();
    await expect(build.getByText("Loading position data...", { exact: true })).toHaveCount(0);
    expect(await queries()).toHaveLength(2);
    await page.evaluate(
        ({ commands, response }) =>
            window.__E2E_TAURI__.configure({
                commands: { ...commands, search_position: { result: response } },
            }),
        { commands, response: stats("Bc5") },
    );
    await build.getByRole("button", { name: "Italian Game", exact: true }).click();
    const continuation = build.getByRole("button", { name: /3\.\.\. Bc5/ });
    await expect(continuation).toBeVisible();
    await expect(build.getByText("Loading position data...", { exact: true })).toHaveCount(0);
    await expect(complete).toHaveCount(0);
    await expect(build.getByRole("button", { name: /Next gap|Biggest gap/i })).toHaveCount(0);
    await expect(build.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
    const startFen = "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq -";
    expect(
        (await queries())
            .slice(2)
            .map(
                ({ args }) => (args as { query: { position: { fen: string } } }).query.position.fen,
            ),
    ).toEqual([startFen, startFen]);
    await assertNoHorizontalOverflow();
    await testInfo.attach("repertoire-italian-successful-incomplete.png", {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
    });

    await page.evaluate(
        ({ commands, outcomes }) =>
            window.__E2E_TAURI__.configure({
                commands: { ...commands, search_position: { outcomes, result: [[], []] } },
            }),
        {
            commands,
            outcomes: [{ result: stats("d3") }, { result: stats("Bc5") }, { result: stats("d3") }],
        },
    );
    await continuation.click();
    const response = build.getByRole("button", { name: /4\. d3/ });
    await expect(response).toBeVisible();
    await expect(build.getByText("Loading position data...", { exact: true })).toHaveCount(0);
    expect(await queries()).toHaveLength(7);
    await page.evaluate(
        ({ commands, outcomes }) =>
            window.__E2E_TAURI__.configure({
                commands: { ...commands, search_position: { outcomes, result: [[], []] } },
            }),
        {
            commands,
            outcomes: [
                { result: [[], []] },
                { result: stats("Bc5") },
                { result: stats("d3") },
                { result: [[], []] },
            ],
        },
    );
    await response.click();
    await expect(build.getByText("Loading position data...", { exact: true })).toHaveCount(0);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(complete).toBeVisible();
    await expect(continuation.getByRole("progressbar").last()).toHaveAttribute(
        "aria-valuenow",
        "100",
    );
    expect(await queries()).toHaveLength(11);
    const calls = await page.evaluate(() => window.__E2E_TAURI__.invocations());
    expect(calls.filter(({ command }) => command === "write_game")).toHaveLength(0);
    await assertNothingClipped(complete, { mode: "reachable" });
    await assertNoHorizontalOverflow();
    await testInfo.attach("repertoire-italian-prepared-complete.png", {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
    });
});

test("workspace-tabs: real transposed practice card selects and reveals the existing answer-bearing occurrence", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
}, testInfo) => {
    const now = new Date("2026-10-21T12:00:00Z");
    await page.clock.install({ time: now });
    await page.clock.pauseAt(now.getTime() + 1000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript(() => localStorage.setItem("auto-save", "false"));
    const repertoireFile = {
        ...filesWorkspaceFixture.pgnFile,
        metadata: { type: "repertoire" as const, tags: [] },
    };
    const game = {
        pgn: '[Event "Transposed practice"]\n[Result "*"]\n\n1. Nf3 (1. Nc3 Nc6 2. Nf3 Nf6 3. e4) Nf6 2. Nc3 Nc6 *',
        stamp: "f".repeat(64),
        revision: "transposed-practice",
        present: true,
    };
    await mockScenario({
        commands: filesWorkspaceCommands([[repertoireFile]], {
            ...pgnFileCommands,
            read_game: { result: game },
            read_games: { result: [game] },
            file_revision: { result: game.revision },
            lex_pgn: {
                result: [
                    { type: "Header", value: { tag: "Event", value: "Transposed practice" } },
                    { type: "Header", value: { tag: "Result", value: "*" } },
                    { type: "San", value: "Nf3" },
                    { type: "ParenOpen" },
                    ...["Nc3", "Nc6", "Nf3", "Nf6", "e4"].map((value) => ({ type: "San", value })),
                    { type: "ParenClose" },
                    ...["Nf6", "Nc3", "Nc6"].map((value) => ({ type: "San", value })),
                    { type: "Outcome", value: "*" },
                ],
            },
        }),
    });
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose collection", exact: true }).click();
    await selectFilesTreeRow(page, repertoireFile.name);
    await page.getByRole("button", { name: "Open game", exact: true }).click();
    const full = page.getByRole("button", { name: /Practice full repertoire/i });
    await expect(full).toBeVisible();
    // Deliver the existing 250ms deck-sync debounce before starting the held-clock drill.
    await page.clock.runFor(300);
    await expect(full).toBeEnabled();
    await full.click();
    const board = page.getByRole("grid", { name: "Chessboard, White orientation", exact: true });
    for (const [from, to] of [
        ["b1", "c3"],
        ["g1", "f3"],
    ]) {
        await playBoardMove(page, page.locator("cg-board").first(), from, to);
        await page.clock.runFor(1);
        await page.clock.runFor(300);
    }
    await page.clock.runFor(300);
    const tab = (await activeWorkspaceTab(page))!;
    const storedTree = async () => {
        const raw = await page.evaluate(
            (key) => sessionStorage.getItem(key),
            tab.treeKey ?? tab.value,
        );
        expect(raw).not.toBeNull();
        return deserializeStorageValue<{
            state: {
                root: unknown;
                headers: unknown;
                position: number[];
                practicePath: number[];
                dirty: boolean;
                sourceStamp: string;
                linkedSource?: unknown;
            };
        }>(raw!)!.state;
    };
    const before = await storedTree();
    expect(before).toMatchObject({
        position: [1, 0, 0, 0],
        practicePath: [1, 0, 0, 0],
        dirty: false,
        sourceStamp: game.stamp,
    });
    await page.keyboard.press("ArrowRight");
    await playBoardMove(page, page.locator("cg-board").first(), "d2", "d4");
    await page.clock.runFor(1);
    await expect(page.getByText("The correct move was e4", { exact: true })).toBeVisible();
    await page.clock.runFor(499);
    expect((await storedTree()).position).toEqual(before.position);
    await expect(board.getByRole("gridcell", { name: "e4, empty", exact: true })).toHaveCount(1);
    await page.clock.runFor(1);
    await expect(board.getByRole("gridcell", { name: "e4, White Pawn", exact: true })).toHaveCount(
        1,
    );
    await page.clock.runFor(300);
    const after = await storedTree();
    expect(after.position).toEqual([1, 0, 0, 0, 0]);
    expect(after.practicePath).toEqual(before.practicePath);
    expect(after.root).toEqual(before.root);
    expect(after.headers).toEqual(before.headers);
    expect(after.linkedSource).toEqual(before.linkedSource);
    expect(after.sourceStamp).toBe(before.sourceStamp);
    expect(after.dirty).toBe(false);
    const calls = await page.evaluate(() => window.__E2E_TAURI__.invocations());
    const sync = calls.filter(({ command }) => command === "sync_practice_positions");
    expect(sync).toHaveLength(1);
    expect(
        JSON.parse((sync[0].args as { positionsDocument: string }).positionsDocument).positions.map(
            (position: { answer: string }) => position.answer,
        ),
    ).toEqual(["Nc3", "Nf3", "e4"]);
    expect(calls.filter(({ command }) => command === "record_practice_review")).toHaveLength(0);
    expect(calls.filter(({ command }) => command === "write_game")).toHaveLength(0);
    await testInfo.attach("practice-transposed-existing-answer.png", {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
    });
    await page.clock.resume();
    await page.getByRole("button", { name: "Show all positions", exact: true }).click();
    const positionCard = page
        .locator(".mantine-Card-root")
        .filter({ has: page.getByText("3. e4", { exact: true }) });
    await expect(positionCard).toBeVisible();
    await positionCard.getByRole("button").click();
    await expect.poll(async () => (await storedTree()).position).toEqual([1, 0, 0, 0]);
    await assertNoHorizontalOverflow();
    await testInfo.attach("practice-transposed-card-navigation.png", {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
    });
});

async function rejectWorkspaceWrites(page: import("@playwright/test").Page) {
    await page.evaluate(() => {
        const target = window as typeof window & {
            __workspaceSetItem?: typeof Storage.prototype.setItem;
        };
        target.__workspaceSetItem ??= Storage.prototype.setItem;
        const original = target.__workspaceSetItem;
        Storage.prototype.setItem = function (key, value) {
            if (key === "workspace") throw new DOMException("quota", "QuotaExceededError");
            return original.call(this, key, value);
        };
    });
}

async function restoreWorkspaceWrites(page: import("@playwright/test").Page) {
    await page.evaluate(() => {
        const target = window as typeof window & {
            __workspaceSetItem?: typeof Storage.prototype.setItem;
        };
        if (target.__workspaceSetItem) Storage.prototype.setItem = target.__workspaceSetItem;
    });
}

test("workspace-tabs: creates, focuses, and cycles workspace tabs", async ({
    page,
    assertAccessible,
    assertNoHorizontalOverflow,
    capture,
}) => {
    await page.goto("/");

    await expect(page).toHaveTitle(/ChessFable/i);
    const tabs = page.getByRole("tab");
    await expect(tabs).toHaveCount(1);
    await expect(tabs.first()).toBeFocused();

    await page.getByRole("button", { name: /new tab/i }).click();
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("Control+1");
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
    await assertNoHorizontalOverflow();
    await assertAccessible();
    await capture("workspace-tabs");
    await expect(page).toHaveScreenshot("workspace-tabs.png", { fullPage: true });
});

test("workspace-tabs: refuses failed creation and close until durable retry", async ({
    page,
    capture,
}) => {
    await page.goto("/");
    const tabs = page.getByRole("tab");
    const newTab = page.getByRole("button", { name: /new tab/i });
    const closeTab = page.getByRole("button", { name: /close tab/i });

    await rejectWorkspaceWrites(page);
    await newTab.click();
    await expect(tabs).toHaveCount(1);
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText(/session storage is full/i)).toBeVisible();

    await restoreWorkspaceWrites(page);
    await newTab.click();
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");

    await rejectWorkspaceWrites(page);
    await closeTab.click();
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await capture("workspace-tabs-write-refusal");

    await restoreWorkspaceWrites(page);
    await closeTab.click();
    await expect(tabs).toHaveCount(1);
    await page.reload();
    await expect(tabs).toHaveCount(1);
});

test("workspace-tabs: FEN import keeps its New Tab on a refused write and replaces it on retry", async ({
    page,
    capture,
}) => {
    const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    await page.addInitScript(() => localStorage.setItem("erase-drawables-on-click", "false"));
    await page.goto("/");
    // The analysis board renders its own panel tablist after the workspace one.
    const tabs = page.getByRole("tablist").first().getByRole("tab");
    await expect(tabs).toHaveCount(1);
    await expect(tabs.first()).toHaveText(/new tab/i);

    await page.getByRole("button", { name: /^import$/i }).click();
    const modal = page.getByRole("dialog", { name: /import game/i });
    await modal.getByText("FEN", { exact: true }).click();
    const fenInput = modal.getByRole("textbox", { name: "FEN" });
    await fenInput.fill(fen);

    await rejectWorkspaceWrites(page);
    await modal.getByRole("button", { name: /^import$/i }).click();
    await expect(page.getByText(/session storage is full/i)).toBeVisible();
    await expect(modal).toBeVisible();
    await expect(fenInput).toHaveValue(fen);
    await expect(tabs).toHaveCount(1);
    await expect(tabs.first()).toHaveText(/new tab/i);
    await capture("workspace-tabs-import-refused");
    await expect(page).toHaveScreenshot("workspace-tabs-import-refused.png", { fullPage: true });

    // Dismiss the refusal before retrying so its auto-close timer cannot race the next snapshot.
    await page.locator(".mantine-Notification-closeButton").click();
    await expect(page.getByText(/session storage is full/i)).toBeHidden();
    await restoreWorkspaceWrites(page);
    await modal.getByRole("button", { name: /^import$/i }).click();
    const board = page.getByRole("grid", { name: "Chessboard, White orientation", exact: true });
    await expect(board).toBeVisible();
    await expect(tabs).toHaveCount(1);
    await expect(tabs.first()).toHaveText(/analysis board/i);
    await expect(page.getByRole("gridcell", { name: "e4, White Pawn", exact: true })).toHaveCount(
        1,
    );
    await expect(page.getByRole("gridcell", { name: "e2, empty", exact: true })).toHaveCount(1);
    await capture("workspace-tabs-import-committed");
    await expect(page).toHaveScreenshot("workspace-tabs-import-committed.png", { fullPage: true });

    await preserveStorageForReload(page);
    await expect(tabs).toHaveCount(1);
    await expect(tabs.first()).toHaveText(/analysis board/i);
    await expect(board).toBeVisible();
    await expect(page.getByRole("gridcell", { name: "e4, White Pawn", exact: true })).toHaveCount(
        1,
    );
});
