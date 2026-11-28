import type { LexPgnGamesOutcome, Token } from "../src/bindings/generated";
import {
    assertNothingClipped,
    expect,
    filesWorkspaceCommands,
    filesWorkspaceFixture,
    seedBoardLayouts,
    selectFilesTreeRow,
    test,
} from "./fixtures";

const REVISION = "e2e-repertoire-pgn-import-rev-1";

test("create repertoire from pasted multi-game PGN as Black marks conflicting move for review", async ({
    page,
    mockScenario,
    assertAccessible,
    assertNoHorizontalOverflow,
}) => {
    const mergedPgn =
        '[Event "Sicilian Defense"]\n[Site "?"]\n[Date "????.??.??"]\n[Round "?"]\n[White "?"]\n[Black "?"]\n[Result "*"]\n[Orientation "black"]\n\n1. e4 c5 2. Nf3 d6 (2... Nc6 { [%crreview] }) *';
    const mergedTokens: Token[] = [
        { type: "Header", value: { tag: "Event", value: "Sicilian Defense" } },
        { type: "Header", value: { tag: "Result", value: "*" } },
        { type: "Header", value: { tag: "Orientation", value: "black" } },
        { type: "San", value: "e4" },
        { type: "San", value: "c5" },
        { type: "San", value: "Nf3" },
        { type: "San", value: "d6" },
        { type: "ParenOpen" },
        { type: "San", value: "Nc6" },
        { type: "Comment", value: " [%crreview] " },
        { type: "ParenClose" },
        { type: "Outcome", value: "*" },
    ];
    const lexOutcome: LexPgnGamesOutcome = {
        status: "games",
        games: [
            {
                status: "ok",
                tokens: [
                    { type: "San", value: "e4" },
                    { type: "San", value: "c5" },
                    { type: "San", value: "Nf3" },
                    { type: "San", value: "d6" },
                    { type: "Outcome", value: "*" },
                ],
            },
            {
                status: "ok",
                tokens: [
                    { type: "San", value: "e4" },
                    { type: "San", value: "c5" },
                    { type: "San", value: "Nf3" },
                    { type: "San", value: "Nc6" },
                    { type: "Outcome", value: "*" },
                ],
            },
        ],
    };

    const createdEntry = {
        handle: { id: { id: "sicilian-rep" }, kind: "fileWorkspace" as const },
        kind: "file" as const,
        name: "Sicilian Defense",
        children: [],
        metadata: { type: "repertoire" as const, tags: [] },
        gameCount: 1,
        lastModified: 1,
    };

    await mockScenario({
        commands: {
            lex_pgn_games: { result: lexOutcome },
            create_workspace_file: { result: createdEntry },
            count_pgn_games: { result: 1 },
            file_revision: { result: REVISION },
            read_games: {
                pgnGames: [
                    { pgn: mergedPgn, stamp: "a".repeat(64), revision: REVISION, present: true },
                ],
            },
            read_game: {
                result: {
                    pgn: mergedPgn,
                    stamp: "a".repeat(64),
                    revision: REVISION,
                    present: true,
                },
            },
            lex_pgn: { pgnTokens: { [mergedPgn]: mergedTokens } },
        },
    });

    await page.goto("/");
    await page.getByRole("button", { name: "New Repertoire", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New Repertoire" });
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Sicilian Defense");
    await dialog.getByText("BLACK", { exact: true }).click();
    await dialog
        .getByRole("textbox", { name: "PGN Game", exact: true })
        .fill("1. e4 c5 2. Nf3 d6 *\n\n1. e4 c5 2. Nf3 Nc6 *");
    await assertNoHorizontalOverflow();
    await assertNothingClipped(dialog);
    await assertAccessible();
    await dialog.getByRole("button", { name: "Create", exact: true }).click();

    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".mantine-Notification-root")).toContainText(
        "Games read: 2 · Skipped: 0 · Not placed: 0 · Conflicts marked: 1",
    );
    await expect(page.locator(".cg-wrap.orientation-black").first()).toBeVisible();

    const notation = page.locator("#bottomRight");
    const markedMove = notation.locator('[data-notation-review-mark="true"]');
    await expect(markedMove).toHaveCount(1);
    await expect(markedMove).toHaveAttribute(
        "aria-label",
        /^(?:Nc6|♘c6), imported move, differs from your repertoire — review$/,
    );

    const createCalls = await page.evaluate(() =>
        window.__E2E_TAURI__
            .invocations()
            .filter((item) => item.command === "create_workspace_file"),
    );
    expect(createCalls).toHaveLength(1);
    const writtenPgn = (createCalls[0].args as { content: { pgn: string } }).content.pgn;
    expect(writtenPgn).toContain('[Orientation "black"]');
    expect(writtenPgn).toContain("[%crreview]");
});

test("Import dialog Save to collection as Repertoire sets chosen colour without preflighting game 0", async ({
    page,
    mockScenario,
    assertAccessible,
    assertNoHorizontalOverflow,
}) => {
    const pickedHandle = { id: { id: "picked-pgn" }, kind: "fileWorkspace" as const };
    const sourcePgn = "1. e4 c5 *";
    const mergedPgn =
        '[Event "French & Sicilian"]\n[Site "?"]\n[Date "????.??.??"]\n[Round "?"]\n[White "?"]\n[Black "?"]\n[Result "*"]\n[Orientation "black"]\n\n1. e4 c5 *';
    const sourceTokens: Token[] = [
        { type: "San", value: "e4" },
        { type: "San", value: "c5" },
        { type: "Outcome", value: "*" },
    ];
    const mergedTokens: Token[] = [
        { type: "Header", value: { tag: "Event", value: "French & Sicilian" } },
        { type: "Header", value: { tag: "Result", value: "*" } },
        { type: "Header", value: { tag: "Orientation", value: "black" } },
        ...sourceTokens,
    ];
    const createdEntry = {
        handle: { id: { id: "imported-rep" }, kind: "fileWorkspace" as const },
        kind: "file" as const,
        name: "French & Sicilian",
        children: [],
        metadata: { type: "repertoire" as const, tags: [] },
        gameCount: 1,
        lastModified: 1,
    };

    await mockScenario({
        commands: {
            issue_pgn_workspace: {
                result: {
                    handle: pickedHandle,
                    displayName: "French & Sicilian.pgn",
                    availability: "available",
                },
            },
            count_pgn_games: { result: 1 },
            read_games: {
                pgnGames: [
                    { pgn: sourcePgn, stamp: "s".repeat(64), revision: REVISION, present: true },
                ],
            },
            create_workspace_file: { result: createdEntry },
            file_revision: { result: REVISION },
            read_game: {
                result: {
                    pgn: mergedPgn,
                    stamp: "b".repeat(64),
                    revision: REVISION,
                    present: true,
                },
            },
            lex_pgn: {
                pgnTokens: {
                    [sourcePgn]: sourceTokens,
                    [mergedPgn]: mergedTokens,
                },
            },
        },
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Import", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Import Game" });
    await dialog.getByRole("button", { name: /^PGN file/ }).click();
    await dialog.getByRole("checkbox", { name: "Save to collection", exact: true }).check();
    await dialog.getByText("Repertoire", { exact: true }).click();
    await dialog.getByText("BLACK", { exact: true }).click();
    await assertNoHorizontalOverflow();
    await assertNothingClipped(dialog);
    await assertAccessible();
    await dialog.getByRole("button", { name: "Import", exact: true }).click();

    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".mantine-Notification-root")).toContainText(
        "Games read: 1 · Skipped: 0 · Not placed: 0 · Conflicts marked: 0",
    );
    await expect(page.locator(".cg-wrap.orientation-black").first()).toBeVisible();

    const invocations = await page.evaluate(() => window.__E2E_TAURI__.invocations());
    const createIndex = invocations.findIndex((item) => item.command === "create_workspace_file");
    const firstReadGameIndex = invocations.findIndex((item) => item.command === "read_game");
    expect(createIndex).toBeGreaterThan(-1);
    expect(firstReadGameIndex).toBeGreaterThan(createIndex);
    const writtenPgn = (invocations[createIndex].args as { content: { pgn: string } }).content.pgn;
    expect(writtenPgn).toContain('[Orientation "black"]');
});

test("import PGN into open repertoire without reference DB shows review mark, Mark as reviewed clears it, and undo restores it", async ({
    page,
    mockScenario,
    assertAccessible,
    assertNoHorizontalOverflow,
}) => {
    const repertoireFile = {
        ...filesWorkspaceFixture.pgnFile,
        handle: { id: { id: "open-rep" }, kind: "fileWorkspace" as const },
        name: "White Rep",
        metadata: { type: "repertoire" as const, tags: [] },
        gameCount: 1,
    };
    const initialPgn =
        '[Event "White Rep"]\n[Site "?"]\n[Date "????.??.??"]\n[Round "?"]\n[White "?"]\n[Black "?"]\n[Result "*"]\n[Orientation "white"]\n\n1. e4 e5 *';
    const initialTokens: Token[] = [
        { type: "Header", value: { tag: "Event", value: "White Rep" } },
        { type: "Header", value: { tag: "Result", value: "*" } },
        { type: "Header", value: { tag: "Orientation", value: "white" } },
        { type: "San", value: "e4" },
        { type: "San", value: "e5" },
        { type: "Outcome", value: "*" },
    ];
    const chapter = { pgn: initialPgn, stamp: "c".repeat(64), revision: REVISION, present: true };

    // The spec is about the import, not the repertoire preset: keep the two-pane default layout.
    await seedBoardLayouts(page);
    await mockScenario({
        commands: filesWorkspaceCommands([[repertoireFile]], {
            count_pgn_games: { result: 1 },
            read_games: { pgnGames: [chapter] },
            read_game: { pgnGames: [chapter] },
            file_revision: { result: REVISION },
            lex_pgn: { pgnTokens: { [initialPgn]: initialTokens } },
            lex_pgn_games: {
                result: {
                    status: "games",
                    games: [
                        {
                            status: "ok",
                            tokens: [
                                { type: "San", value: "d4" },
                                { type: "San", value: "d5" },
                                { type: "Outcome", value: "*" },
                            ],
                        },
                    ],
                } satisfies LexPgnGamesOutcome,
            },
        }),
    });

    await page.addInitScript(() => {
        localStorage.setItem("auto-save", "false");
    });
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    await selectFilesTreeRow(page, "White Rep");
    await page.locator('[data-line-index="0"] [role="button"]').dblclick();
    await expect(page).toHaveURL("/");

    await page.getByRole("tab", { name: "Practice", exact: true }).click();
    await page.getByRole("tab", { name: "Build", exact: true }).click();
    await expect(
        page.getByText("Select a reference database to use the Build view.", { exact: true }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Import PGN", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Import PGN into repertoire" });
    await dialog.getByRole("textbox", { name: "PGN Game", exact: true }).fill("1. d4 d5 *");
    await assertNoHorizontalOverflow();
    await assertNothingClipped(dialog);
    await assertAccessible();
    await dialog.getByRole("button", { name: "Import", exact: true }).click();

    await expect(dialog).toHaveCount(0);
    const notification = page.locator(".mantine-Notification-root");
    await expect(notification).toContainText(
        "Games read: 1 · Skipped: 0 · Not placed: 0 · Conflicts marked: 1",
    );
    await notification.locator(".mantine-Notification-closeButton").click();
    await expect(notification).toHaveCount(0);

    const notation = page.locator("#bottomRight");
    const markedMove = notation.locator('[data-notation-review-mark="true"]');
    await expect(markedMove).toHaveCount(1);
    await expect(markedMove).toHaveAttribute(
        "aria-label",
        "d4, imported move, differs from your repertoire — review",
    );
    const unmarkedMove = notation.getByRole("button", { name: "e5", exact: true });
    const [markedBg, unmarkedBg] = await Promise.all([
        markedMove.evaluate((el) => getComputedStyle(el).backgroundColor),
        unmarkedMove.evaluate((el) => getComputedStyle(el).backgroundColor),
    ]);
    expect(markedBg).not.toBe(unmarkedBg);

    await assertNoHorizontalOverflow();
    await assertNothingClipped(notation);
    await assertAccessible();

    await markedMove.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Mark as reviewed", exact: true }).click();
    await expect(notation.locator('[data-notation-review-mark="true"]')).toHaveCount(0);

    await page.keyboard.press("Control+z");
    await expect(notation.locator('[data-notation-review-mark="true"]')).toHaveCount(1);
});
