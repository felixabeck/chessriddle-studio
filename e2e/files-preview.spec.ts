import AxeBuilder from "@axe-core/playwright";
import type { Locator } from "@playwright/test";
import {
    assertChooserInsideBoard,
    expect,
    filesWorkspaceCommands,
    filesWorkspaceFixture,
    pgnFileCommands,
    selectFilesTreeRow,
    test,
    gameOpeningCommands,
    gameOpeningFixture,
    activeWorkspaceTab,
    whitePawnSquares,
} from "./fixtures";

// A wide, short window at 100% font with a file of many games: the shape in which the card's old
// fixed height left the game list two rows high and cut off the lower ranks and the move controls.
const repertoireFile = { ...filesWorkspaceFixture.pgnFile, gameCount: 21 };
const MIN_VISIBLE_GAME_ROWS = 4;
const GAME_ROW_HEIGHT_PX = 30;
// Covers 10 attempts × 3 animation frames each, plus a 2-frame margin for queued callbacks.
const SCROLL_SETTLE_FRAMES = 32;

for (const compact of [false, true]) {
    test(`files-preview: Trash view ${compact ? "320px at 200%" : "standard"}`, async ({
        page,
        mockScenario,
        assertNoHorizontalOverflow,
    }) => {
        await page.setViewportSize({ width: compact ? 320 : 1280, height: compact ? 3200 : 900 });
        await page.addInitScript(
            (scale) => localStorage.setItem("font-size", String(scale)),
            compact ? 200 : 100,
        );
        const item = "11111111-1111-4111-8111-111111111111";
        await mockScenario({
            commands: filesWorkspaceCommands([[]], {
                list_workspace_trash: {
                    result: {
                        items: [
                            {
                                item,
                                kind: "directory",
                                name: "Tournament preparation",
                                originalFolder: "Archive/Openings",
                                trashedSeconds: 1700000000,
                                category: null,
                            },
                            {
                                item: "22222222-2222-4222-8222-222222222222",
                                kind: null,
                                name: "Unreadable bucket",
                                originalFolder: "",
                                trashedSeconds: 1699900000,
                                category: "permission",
                            },
                        ],
                        olderCount: 3,
                        cursor: {
                            seconds: 1699900000,
                            item: "22222222-2222-4222-8222-222222222222",
                        },
                    },
                },
                restore_workspace_trash_item: { result: null },
                delete_workspace_trash_item: { result: null },
                empty_workspace_trash: { result: null },
            }),
        });
        await page.goto("/library");
        await expect(page.locator("html")).toHaveCSS("font-size", compact ? "32px" : "16px");
        await page.getByRole("button", { name: "Choose collection", exact: true }).click();
        const trash = page.getByRole("region", { name: "Trash", exact: true });
        await expect(trash.getByText("Archive/Openings", { exact: true })).toBeVisible();
        await expect(
            trash.getByRole("button", { name: "Restore", exact: true }).first(),
        ).toBeEnabled();
        await expect(
            trash.getByRole("button", { name: "Restore", exact: true }).last(),
        ).toBeDisabled();
        await assertNoHorizontalOverflow();
        await expect(page).toHaveScreenshot(`files-trash-${compact ? "compact" : "standard"}.png`, {
            fullPage: true,
        });
        await trash.getByRole("button", { name: "Restore", exact: true }).first().click();
        const dialog = page.getByRole("dialog", { name: "Restore file", exact: true });
        await dialog.getByRole("button", { name: "Restore", exact: true }).click();
        await expect(dialog).toHaveCount(0);
        const invocations = await page.evaluate(() => window.__E2E_TAURI__.invocations());
        expect(
            invocations.find(({ command }) => command === "restore_workspace_trash_item")?.args,
        ).toEqual({ workspace: filesWorkspaceFixture.workspace, item });
    });
}

const mandateComments = {
    Nf3: "62",
    Be3: "59. Olvidé mi preparación. Tengo Ld3 en mi prep.",
    Be2: "59",
};

function inlineCommentTokens(comments = mandateComments) {
    return [
        { type: "Header", value: { tag: "White", value: "Weiss" } },
        { type: "Header", value: { tag: "Black", value: "Schwarz" } },
        { type: "Header", value: { tag: "Result", value: "*" } },
        ..."d4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e4 O-O Nf3 h6 Be3 Bd6 Be2"
            .split(" ")
            .flatMap((move) => [
                { type: "San", value: move },
                ...(move in comments
                    ? [{ type: "Comment", value: comments[move as keyof typeof comments] }]
                    : []),
            ]),
    ];
}

function tallCommentTokens(prefixMoves: string[] = []) {
    const longComment = Array.from(
        { length: 24 },
        (_, index) => `Preparation note ${index + 1}: develop the pieces and keep the king safe.`,
    ).join("\n\n");
    const tokens = inlineCommentTokens({
        ...mandateComments,
        Nf3: `${mandateComments.Nf3}\n\n${longComment}`,
        Be3: `${mandateComments.Be3}\n\n${longComment}`,
    });
    return [
        ...tokens.slice(0, 3),
        ...prefixMoves.map((move) => ({ type: "San", value: move })),
        ...tokens.slice(3),
    ];
}

async function expectCurrentNotationCellVisible(notation: Locator, move: string) {
    const currentCell = notation.locator('[data-notation-current="true"]');
    await expect(currentCell.getByRole("button", { name: move, exact: true })).toHaveCount(1);
    const isInsideViewport = () =>
        currentCell.evaluate((cell) => {
            const viewport = cell.closest(".mantine-ScrollArea-viewport")!;
            const bounds = cell.getBoundingClientRect();
            const top = viewport.getBoundingClientRect().top + viewport.clientTop;
            return bounds.top >= top && bounds.bottom <= top + viewport.clientHeight;
        });
    await expect.poll(isInsideViewport).toBe(true);
    // Let queued virtualizer retries run before checking that the selected cell stays visible.
    await notation.page().evaluate(async (settleFrames) => {
        for (let frame = 0; frame < settleFrames; frame += 1) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
    }, SCROLL_SETTLE_FRAMES);
    expect(await isInsideViewport()).toBe(true);
}

for (const gesture of ["button", "double-click", "Enter"] as const) {
    test(`files-preview: non-first game ${gesture} opens its content and file index`, async ({
        page,
        mockScenario,
        capture,
    }) => {
        await mockScenario({
            commands: filesWorkspaceCommands([[gameOpeningFixture.file]], gameOpeningCommands),
        });
        await page.goto("/library");
        await page.getByRole("button", { name: "Choose collection", exact: true }).click();
        await selectFilesTreeRow(page, gameOpeningFixture.file.name);
        const second = page.getByRole("option", { name: /Second White - Second Black/ });
        const first = page.getByRole("option", { name: /First White - First Black/ });
        await expect(second).toBeVisible();
        const openGame = page.getByRole("button", { name: "Open game", exact: true });
        await expect(openGame).toHaveText("Open game");
        await expect(openGame).toBeEnabled();
        await capture("files-labelled-game");
        await expect(page).toHaveScreenshot("files-labelled-game.png", { fullPage: true });
        if (gesture === "button") {
            const before = await second.boundingBox();
            await second.click();
            await expect(second).toHaveAttribute("aria-selected", "true");
            await expect(page).toHaveURL("/library");
            expect(await second.boundingBox()).toEqual(before);
            await openGame.click();
        } else if (gesture === "double-click") {
            await expect(first).toHaveAttribute("aria-selected", "true");
            await second.dblclick();
        } else {
            await second.focus();
            await second.press("Enter");
        }
        await expect(page).toHaveURL(/\/$/);
        await expect(page.getByRole("tab", { name: /Second White - Second Black/ })).toBeVisible();
        expect((await activeWorkspaceTab(page))?.gameOrigin).toMatchObject({
            kind: "file",
            file: { handle: gameOpeningFixture.file.handle },
            gameNumber: 1,
        });
        await expect(page.getByRole("button", { name: "d4", exact: true })).toBeVisible();
    });
}

test("files-preview: a dragged row's preview keeps the row's real size and layout", async ({
    page,
    mockScenario,
}) => {
    await mockScenario({ commands: filesWorkspaceCommands([[repertoireFile]], pgnFileCommands) });
    await page.goto("/library");
    await page.getByRole("button", { name: /choose collection/i }).click();
    const row = page.getByRole("treeitem", { name: repertoireFile.name, exact: true });
    await expect(row).toBeVisible();

    const measured = await row.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const dataTransfer = new DataTransfer();
        const fire = (target: EventTarget, type: string, x: number, y: number) =>
            target.dispatchEvent(
                new DragEvent(type, { bubbles: true, dataTransfer, clientX: x, clientY: y }),
            );
        fire(element, "dragstart", bounds.left + 40, bounds.top + 10);
        fire(document, "dragover", bounds.left + 140, bounds.top + 110);
        const preview = document.querySelector<HTMLElement>("body > [inert]")!;
        const rendered = preview.getBoundingClientRect();
        const columns = (root: Element) =>
            getComputedStyle(root.querySelector(":scope > div")!).gridTemplateColumns;
        const result = {
            row: { width: bounds.width, height: bounds.height, left: bounds.left, top: bounds.top },
            preview: {
                width: rendered.width,
                height: rendered.height,
                left: rendered.left,
                top: rendered.top,
            },
            position: getComputedStyle(preview).position,
            rowColumns: columns(element),
            previewColumns: columns(preview.querySelector('[role="treeitem"]')!),
        };
        fire(element, "dragend", 0, 0);
        return { ...result, removed: document.querySelector("body > [inert]") === null };
    });

    expect(measured.preview.width).toBeCloseTo(measured.row.width, 0);
    expect(measured.preview.height).toBeCloseTo(measured.row.height, 0);
    expect(measured.preview.left).toBeCloseTo(measured.row.left + 100, 0);
    expect(measured.preview.top).toBeCloseTo(measured.row.top + 100, 0);
    expect(measured.position).toBe("fixed");
    expect(measured.previewColumns).toBe(measured.rowColumns);
    expect(measured.removed).toBe(true);
});

test("files-preview: the card fills the window and shows the whole board and its controls", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
    capture,
}) => {
    // A ChessBase evaluation profile ahead of the first move: machine data, never comment prose.
    const lexPgn = pgnFileCommands.lex_pgn.result as unknown[];
    const firstMove = lexPgn.findIndex((token) => (token as { type: string }).type === "San");
    const withCommand = [
        ...lexPgn.slice(0, firstMove),
        { type: "Comment", value: "[%evp 0,34,61,53] sofort vertreiben" },
        ...lexPgn.slice(firstMove),
    ];
    await mockScenario({
        commands: filesWorkspaceCommands([[repertoireFile]], {
            ...pgnFileCommands,
            lex_pgn: { result: withCommand },
        }),
    });
    await page.goto("/library");
    await page.getByRole("button", { name: /choose collection/i }).click();
    await selectFilesTreeRow(page, repertoireFile.name);
    await expect(page.getByText("Weiss - Schwarz").first()).toBeVisible();
    await expect
        .poll(() => page.getByText("Weiss - Schwarz").count())
        .toBeGreaterThanOrEqual(MIN_VISIBLE_GAME_ROWS);
    await expect(page.getByText("sofort vertreiben")).toBeVisible();
    await expect(page.getByText(/%evp/)).toHaveCount(0);

    const listViewport = page
        .locator(".mantine-ScrollArea-viewport")
        .filter({ has: page.getByText("Weiss - Schwarz").first() });
    const listHeight = await listViewport.evaluate((element) => element.clientHeight);
    expect(listHeight).toBeGreaterThanOrEqual(MIN_VISIBLE_GAME_ROWS * GAME_ROW_HEIGHT_PX);

    const board = page.locator(".cg-wrap");
    await expect(board).toBeInViewport({ ratio: 1 });
    const boardBox = await board.boundingBox();
    expect(boardBox).not.toBeNull();
    expect(Math.abs(boardBox!.width - boardBox!.height)).toBeLessThanOrEqual(1);
    // The board's own box can be square while an ancestor with `overflow: hidden` cuts it off.
    const clippedBy = await board.evaluate((element) => {
        const bottom = element.getBoundingClientRect().bottom;
        for (let node = element.parentElement; node; node = node.parentElement) {
            if (getComputedStyle(node).overflow === "visible") continue;
            if (node.getBoundingClientRect().bottom + 1 < bottom) return node.className;
        }
        return null;
    });
    expect(clippedBy).toBeNull();

    for (const name of ["Go to start", "Previous move", "Next move", "Go to end"]) {
        await expect(page.getByRole("button", { name, exact: true })).toBeInViewport({ ratio: 1 });
    }

    await assertNoHorizontalOverflow();
    await capture("files-preview");
    await expect(page).toHaveScreenshot("files-preview.png");
});

test("files-preview: variation chooser lies inside the preview board at its top edge", async ({
    page,
    mockScenario,
}) => {
    await mockScenario({
        commands: filesWorkspaceCommands([[repertoireFile]], {
            ...pgnFileCommands,
            lex_pgn: {
                result: [
                    { type: "Header", value: { tag: "White", value: "Weiss" } },
                    { type: "Header", value: { tag: "Black", value: "Schwarz" } },
                    { type: "San", value: "e4" },
                    { type: "ParenOpen" },
                    { type: "San", value: "d4" },
                    { type: "ParenClose" },
                    { type: "San", value: "c5" },
                ],
            },
        }),
    });
    await page.goto("/library");
    await page.getByRole("button", { name: /choose collection/i }).click();
    await selectFilesTreeRow(page, repertoireFile.name);
    const board = page.locator("cg-board");
    await expect(board).toBeVisible();
    await page.getByRole("button", { name: "Next move", exact: true }).click();
    const chooser = page.getByRole("listbox", { name: "Choose a continuation" });
    await expect(chooser.getByRole("option")).toHaveText(["1. e4", "1. d4"]);
    await assertChooserInsideBoard(board, chooser);
    const accessibility = await new AxeBuilder({ page })
        .include('.mantine-Paper-root:has(> [role="listbox"])')
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
    expect(accessibility.violations).toEqual([]);
    await chooser.getByRole("option", { name: "1. d4", exact: true }).click();
    await expect(chooser).toBeHidden();
    // Chessground stores each rendered piece's square in cgKey, independent of orientation.
    await expect
        .poll(() => whitePawnSquares(board))
        .toEqual(["a2", "b2", "c2", "d4", "e2", "f2", "g2", "h2"]);
});

test("files-preview: saved shapes stay beside chooser arrows and follow the chosen node", async ({
    page,
    mockScenario,
}) => {
    await mockScenario({
        commands: filesWorkspaceCommands([[repertoireFile]], {
            ...pgnFileCommands,
            lex_pgn: {
                result: [
                    { type: "Header", value: { tag: "White", value: "Weiss" } },
                    { type: "Header", value: { tag: "Black", value: "Schwarz" } },
                    { type: "Comment", value: "[%cal Ra2a4] [%csl Ch5]" },
                    { type: "San", value: "e4" },
                    { type: "ParenOpen" },
                    { type: "San", value: "d4" },
                    { type: "Comment", value: "[%cal Of7f5]" },
                    { type: "ParenClose" },
                ],
            },
        }),
    });
    await page.goto("/library");
    await page.getByRole("button", { name: /choose collection/i }).click();
    await selectFilesTreeRow(page, repertoireFile.name);
    const preview = page.locator(".cg-wrap");
    await expect(preview).toBeVisible();
    const svg = preview.locator("svg.cg-shapes");
    const savedArrow = svg.locator("g[cgHash*=',a2,a4,red'] line");
    const savedSquare = svg.locator("g[cgHash*=',h5,h5,cyan'] circle");
    await expect(savedArrow).toHaveAttribute("stroke", "#882020");
    await expect(savedSquare).toHaveAttribute("stroke", "#00bcd4");
    await expect(svg.locator("g[cgHash] line")).toHaveCount(1);
    await expect(svg.locator("g[cgHash] circle")).toHaveCount(1);

    await page.getByRole("button", { name: "Next move", exact: true }).click();
    const chooser = page.getByRole("listbox", { name: "Choose a continuation" });
    await expect(chooser.getByRole("option")).toHaveText(["1. e4", "1. d4"]);
    await expect(svg.locator("g[cgHash] line")).toHaveCount(3);
    await expect(svg.locator("g[cgHash] circle")).toHaveCount(1);
    await expect(savedArrow).toHaveAttribute("stroke", "#882020");
    await expect(savedSquare).toHaveAttribute("stroke", "#00bcd4");
    await expect(svg.locator("g[cgHash*=',e2,e4,continuationSelected'] line")).toHaveAttribute(
        "marker-end",
        "url(#arrowhead-cs)",
    );
    await expect(svg.locator("g[cgHash*=',d2,d4,continuationOther'] line")).toHaveAttribute(
        "marker-end",
        "url(#arrowhead-co)",
    );

    await chooser.getByRole("option", { name: "1. d4", exact: true }).click();
    await expect(chooser).toBeHidden();
    await expect(svg.locator("g[cgHash] line")).toHaveCount(1);
    await expect(svg.locator("g[cgHash] circle")).toHaveCount(0);
    await expect(svg.locator("g[cgHash*=',f7,f5,orange'] line")).toHaveAttribute(
        "stroke",
        "#ff6600",
    );
    await expect(page).toHaveURL("/library");
});

test("files-preview: numbered comment prose stays inline with its moves", async ({
    page,
    mockScenario,
}) => {
    await mockScenario({
        commands: filesWorkspaceCommands([[repertoireFile]], {
            ...pgnFileCommands,
            lex_pgn: { result: inlineCommentTokens() },
        }),
    });
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose collection", exact: true }).click();
    await selectFilesTreeRow(page, repertoireFile.name);

    const notation = page
        .locator(".mantine-ScrollArea-viewport")
        .filter({ has: page.getByRole("button", { name: "♘f3", exact: true }) });
    await expect(notation.getByText(mandateComments.Be3, { exact: true })).toBeVisible();
    await expect(notation.locator("ol, li")).toHaveCount(0);
    const nf3 = notation.getByRole("button", { name: "♘f3", exact: true });
    const h6 = notation.getByRole("button", { name: "h6", exact: true });
    await expect(nf3).toBeInViewport({ ratio: 1 });
    await expect(h6).toBeInViewport({ ratio: 1 });
    const nf3Box = (await nf3.boundingBox())!;
    const h6Box = (await h6.boundingBox())!;
    expect(nf3Box.y).toBe(h6Box.y);
    await expect(page).toHaveScreenshot("files-inline-comment-prose.png");
});

test("files-preview: navigation reveals both ends of a notation row taller than its viewport", async ({
    page,
    mockScenario,
}) => {
    await mockScenario({
        commands: filesWorkspaceCommands([[repertoireFile]], {
            ...pgnFileCommands,
            lex_pgn: {
                result: tallCommentTokens(),
            },
        }),
    });
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose collection", exact: true }).click();
    await selectFilesTreeRow(page, repertoireFile.name);

    const notation = page
        .locator(".mantine-ScrollArea-viewport")
        .filter({ has: page.getByRole("button", { name: "d4", exact: true }) });
    const tallRow = notation.locator("[data-index]").filter({
        has: page.getByRole("button", { name: "d4", exact: true }),
    });
    await expect(tallRow.getByRole("button", { name: "♗e2", exact: true })).toHaveCount(1);
    await expect
        .poll(async () => {
            const rowHeight = (await tallRow.boundingBox())?.height ?? 0;
            const viewportHeight = await notation.evaluate((element) => element.clientHeight);
            return rowHeight > viewportHeight && viewportHeight > 0;
        })
        .toBe(true);

    // Toolbar navigation must reveal the cell itself, without a move click scrolling it first.
    for (const move of ["d4", "♗e2", "d4"]) {
        if (move === "d4") {
            await page.getByRole("button", { name: "Go to start", exact: true }).click();
            await page.getByRole("button", { name: "Next move", exact: true }).click();
        } else {
            await page.getByRole("button", { name: "Go to end", exact: true }).click();
        }
        await expectCurrentNotationCellVisible(notation, move);
    }
});

test("files-preview: navigation mounts a distant tall row and reveals its selected cell", async ({
    page,
    mockScenario,
}) => {
    // Forty full rows leave the final commented row outside the viewport and its overscan.
    const earlierMoves = Array.from({ length: 320 }, () => ["Nf3", "Nf6", "Ng1", "Ng8"]).flat();
    await mockScenario({
        commands: filesWorkspaceCommands([[repertoireFile]], {
            ...pgnFileCommands,
            lex_pgn: {
                result: tallCommentTokens(earlierMoves),
            },
        }),
    });
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose collection", exact: true }).click();
    await selectFilesTreeRow(page, repertoireFile.name);

    // Keep the viewport locator stable while virtual rows mount and unmount.
    const notation = page.locator(".mantine-ScrollArea-viewport").filter({
        has: page.locator("[data-index]"),
    });
    const tallRow = notation.locator('[data-index="40"]');
    await expect(tallRow).toHaveCount(0);
    await page.getByRole("button", { name: "Go to end", exact: true }).click();
    await expectCurrentNotationCellVisible(notation, "♗e2");
    expect((await tallRow.boundingBox())!.height).toBeGreaterThan(
        await notation.evaluate((element) => element.clientHeight),
    );

    // Returning to the first short row makes the tall row unmounted again.
    await page.getByRole("button", { name: "Go to start", exact: true }).click();
    await expect(tallRow).toHaveCount(0);
    // Separate events let the short selection commit, without actionability or visibility waits.
    await page
        .getByRole("button", { name: "Next move", exact: true })
        .evaluate((button: HTMLButtonElement) => button.click());
    await page
        .getByRole("button", { name: "Go to end", exact: true })
        .evaluate((button: HTMLButtonElement) => button.click());
    await expectCurrentNotationCellVisible(notation, "♗e2");

    // The fifteen-move final row starts at d4, fourteen plies before its end.
    await page.evaluate(() => {
        const previous = document.querySelector<HTMLButtonElement>(
            'button[aria-label="Previous move"]',
        )!;
        for (let index = 0; index < 14; index += 1) previous.click();
    });
    await expectCurrentNotationCellVisible(notation, "d4");
});
