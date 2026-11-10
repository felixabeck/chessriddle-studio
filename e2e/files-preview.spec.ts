import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
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
    type MockScenario,
} from "./fixtures";

// A wide, short window at 100% font with a file of many games: the shape in which the card's old
// fixed height left the game list two rows high and cut off the lower ranks and the move controls.
const repertoireFile = { ...filesWorkspaceFixture.pgnFile, gameCount: 21 };
const MIN_VISIBLE_GAME_ROWS = 4;
const GAME_ROW_HEIGHT_PX = 30;
// Covers 10 attempts × 3 animation frames each, plus a 2-frame margin for queued callbacks.
const SCROLL_SETTLE_FRAMES = 32;

async function expectLineTitle(row: Locator, name: string, idea: string) {
    await expect(row.getByText(name, { exact: true })).toBeVisible();
    const subtitle = row.getByText(idea, { exact: true });
    await expect(subtitle).toBeVisible();
    await expect(subtitle).toHaveAttribute("style", /color: var\(--mantine-color-dimmed\)/);
    await expect(row).not.toHaveText(/ - /);
}

async function openDragFile(
    page: Page,
    mockScenario: (scenario: MockScenario) => Promise<void>,
    repertoire = true,
) {
    const file = {
        ...repertoireFile,
        gameCount: 80,
        metadata: { type: repertoire ? "repertoire" : "game", tags: [] },
    };
    const games = Array.from({ length: file.gameCount }, (_, index) => {
        const section = index === 0 ? "First section" : index === 3 ? "Second section" : undefined;
        const headers = [
            { tag: "White", value: `White ${index + 1}` },
            { tag: "Black", value: `Black ${index + 1}` },
            ...(section ? [{ tag: "Section", value: section }] : []),
        ];
        const pgn = `${headers.map(({ tag, value }) => `[${tag} "${value}"]`).join("\n")}\n\n1. e4 c5 *`;
        return {
            game: {
                pgn,
                stamp: String(index + 1).padStart(64, "0"),
                revision: "drag-revision",
                present: true,
            },
            tokens: [
                ...headers.map((value) => ({ type: "Header", value })),
                { type: "San", value: "e4" },
                { type: "San", value: "c5" },
                { type: "Outcome", value: "*" },
            ],
        };
    });
    await mockScenario({
        commands: filesWorkspaceCommands([[file]], {
            read_games: { pgnGames: games.map(({ game }) => game) },
            read_game: { pgnGames: games.map(({ game }) => game) },
            file_revision: { result: "drag-revision" },
            lex_pgn: {
                pgnTokens: Object.fromEntries(games.map(({ game, tokens }) => [game.pgn, tokens])),
            },
            move_games: { result: { changed: false, start: 0, order: [] } },
        }),
    });
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose collection", exact: true }).click();
    await selectFilesTreeRow(page, file.name);
    const list = page.getByRole("listbox", { name: "Games", exact: true });
    const second = list.locator('[data-line-index="1"] [role="option"]');
    if (repertoire) await expectLineTitle(second, "White 2", "Black 2");
    else await expect(second).toHaveText(/White 2 - Black 2/);
    return list;
}

const lineMoves = (page: Page) =>
    page.evaluate(() =>
        window.__E2E_TAURI__.invocations().filter(({ command }) => command === "move_games"),
    );

async function startLineDrag(page: Page, row: Locator) {
    const box = (await row.boundingBox())!;
    await page.mouse.move(box.x + 45, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 55, box.y + box.height / 2, { steps: 3 });
    await expect(page.locator("[data-line-drag-preview]")).toBeVisible();
    return box;
}

test("files-preview: repertoire clicks below the threshold select and double clicks open", async ({
    page,
    mockScenario,
}) => {
    await page.setViewportSize({ width: 1920, height: 1100 });
    const list = await openDragFile(page, mockScenario);
    const second = list.locator('[data-line-index="1"] [role="option"]');
    const box = (await second.boundingBox())!;
    await page.mouse.move(box.x + 45, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 47, box.y + box.height / 2 + 1);
    await expect(page.locator("[data-line-drag-preview]")).toHaveCount(0);
    await page.mouse.up();
    await expect(second).toHaveAttribute("aria-selected", "true");
    expect(await lineMoves(page)).toEqual([]);
    await second.dblclick();
    await expect(page).toHaveURL(/\/$/);
    expect((await activeWorkspaceTab(page))?.gameOrigin).toMatchObject({ gameNumber: 1 });
});

for (const belowHeading of [false, true]) {
    test(`files-preview: line drops ${belowHeading ? "below" : "above"} a heading`, async ({
        page,
        mockScenario,
        capture,
    }) => {
        await page.setViewportSize({ width: 1920, height: 1100 });
        if (belowHeading) {
            await page.emulateMedia({ reducedMotion: "reduce" });
            await page.addInitScript(() => localStorage.setItem("mantine-color-scheme", "dark"));
        }
        const list = await openDragFile(page, mockScenario);
        const source = list.locator('[data-line-index="1"] [role="option"]');
        const heading = list.locator('[data-line-index="3"] [data-line-part="section"]');
        await expect(heading).toBeInViewport({ ratio: 1 });
        const box = await startLineDrag(page, source);
        const preview = page.locator("[data-line-drag-preview]");
        const previewBox = (await preview.boundingBox())!;
        expect(previewBox.width).toBeCloseTo(box.width, 0);
        expect(previewBox.height).toBeCloseTo(box.height, 0);
        const target = (await (
            belowHeading ? list.locator('[data-line-index="3"] [role="option"]') : heading
        ).boundingBox())!;
        await page.mouse.move(target.x + 60, target.y + 3, { steps: 5 });
        const marker = page.locator("[data-line-drop-marker]");
        await expect(marker).toBeVisible();
        await expect(marker).toHaveAttribute("data-before", "3");
        await expect(marker).toHaveAttribute("data-below-heading", String(belowHeading));
        expect((await marker.boundingBox())!.y + 1).toBeCloseTo(target.y, 0);
        expect(
            await marker.evaluate((element) => {
                const probe = document.createElement("span");
                probe.style.color = "var(--cf-primary)";
                element.append(probe);
                const matches =
                    getComputedStyle(element).backgroundColor === getComputedStyle(probe).color;
                probe.remove();
                return matches;
            }),
        ).toBe(true);
        await capture(`line-drop-${belowHeading ? "below" : "above"}`);
        await page.mouse.up();
        await expect.poll(() => lineMoves(page)).toHaveLength(1);
        expect((await lineMoves(page))[0].args).toEqual({
            file: repertoireFile.handle,
            gameMove: { kind: "line", source: 1, before: 3, belowHeading },
            revision: "drag-revision",
        });
        await expectLineTitle(list.locator('[aria-selected="true"]'), "White 1", "Black 1");
        await expect(preview).toHaveCount(0);
        await expect(marker).toHaveCount(0);
    });
}

test("files-preview: a section moves by its heading only to a section boundary", async ({
    page,
    mockScenario,
    capture,
}) => {
    await page.setViewportSize({ width: 1920, height: 1100 });
    const list = await openDragFile(page, mockScenario);
    const heading = list.locator('[data-line-index="3"] [data-line-part="section"]');
    await expect(heading).toBeInViewport({ ratio: 1 });
    const source = (await heading.boundingBox())!;
    await page.mouse.move(source.x + 45, source.y + source.height / 2);
    await page.mouse.down();
    const middle = (await list.locator('[data-line-index="1"] [role="option"]').boundingBox())!;
    await page.mouse.move(middle.x + 60, middle.y + 5, { steps: 5 });
    const preview = page.locator("[data-line-drag-preview]");
    await expect(preview).toHaveText("Second section");
    const row = (await list.locator('[data-line-index="3"] [role="option"]').boundingBox())!;
    expect((await preview.boundingBox())!.height).toBe(row.height);
    await expect(page.locator("[data-line-drop-marker]")).toBeHidden();
    const target = (await list
        .locator('[data-line-index="0"] [data-line-part="section"]')
        .boundingBox())!;
    await page.mouse.move(target.x + 60, target.y + 3, { steps: 5 });
    await expect(page.locator("[data-line-drop-marker]")).toHaveAttribute("data-before", "0");
    await capture("section-drop");
    await page.mouse.up();
    await expect.poll(() => lineMoves(page)).toHaveLength(1);
    expect((await lineMoves(page))[0].args).toMatchObject({
        gameMove: { kind: "section", source: 3, before: 0, belowHeading: false },
        revision: "drag-revision",
    });
});

test("files-preview: stationary edge scrolling keeps a drag after its source unmounts", async ({
    page,
    mockScenario,
    capture,
}) => {
    const list = await openDragFile(page, mockScenario);
    const viewport = page.locator(".mantine-ScrollArea-viewport").filter({ has: list });
    await expect(viewport).toHaveCount(1);
    const dimensions = await viewport.evaluate((element) => ({
        height: element.clientHeight,
        scrollHeight: element.scrollHeight,
    }));
    expect(dimensions.height).toBeGreaterThan(0);
    expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.height + 300);
    const source = list.locator('[data-line-index="0"] [role="option"]');
    await startLineDrag(page, source);
    const bounds = (await viewport.boundingBox())!;
    await page.mouse.move(bounds.x + 60, bounds.y + bounds.height - 4);
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
    const marker = page.locator("[data-line-drop-marker]");
    await expect(marker).toBeVisible();
    const firstDestination = Number(await marker.getAttribute("data-before"));
    const firstTop = await viewport.evaluate((element) => element.scrollTop);
    await expect
        .poll(() => viewport.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(firstTop + 100);
    await expect
        .poll(async () => Number(await marker.getAttribute("data-before")))
        .toBeGreaterThan(firstDestination);
    await expect(source).toHaveCount(0);
    await expect(page.locator("[data-line-drag-preview]")).toBeVisible();
    await expect(marker).toBeVisible();
    const before = Number(await marker.getAttribute("data-before"));
    expect(before).toBeGreaterThan(3);
    await page.mouse.move(bounds.x + 60, bounds.y + bounds.height / 2);
    await expect(marker).toBeVisible();
    const destination = Number(await marker.getAttribute("data-before"));
    await capture("stationary-edge-scroll");
    await page.mouse.up();
    await expect.poll(() => lineMoves(page)).toHaveLength(1);
    expect((await lineMoves(page))[0].args).toMatchObject({
        gameMove: { kind: "line", source: 0, before: destination, belowHeading: false },
    });
});

test("files-preview: Escape cancels a drag and section buttons never start one", async ({
    page,
    mockScenario,
}) => {
    const list = await openDragFile(page, mockScenario);
    const row = list.locator('[data-line-index="1"] [role="option"]');
    const button = row.getByRole("button", { name: "Start section here", exact: true });
    await row.hover();
    const icon = (await button.locator("svg").boundingBox())!;
    await page.mouse.move(icon.x + icon.width / 2, icon.y + icon.height / 2);
    await page.mouse.down();
    await page.mouse.move(icon.x - 60, icon.y, { steps: 5 });
    await expect(page.locator("[data-line-drag-preview]")).toHaveCount(0);
    await page.mouse.up();
    await startLineDrag(page, row);
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-line-drag-preview]")).toHaveCount(0);
    await expect(page.locator("[data-line-drop-marker]")).toHaveCount(0);
    await page.mouse.up();
    expect(await lineMoves(page)).toEqual([]);
    await row.click();
    await expect(row).toHaveAttribute("aria-selected", "true");
});

test("files-preview: other file types keep their row gestures", async ({ page, mockScenario }) => {
    const list = await openDragFile(page, mockScenario, false);
    const second = list.locator('[data-line-index="1"] [role="option"]');
    const box = (await second.boundingBox())!;
    await page.mouse.move(box.x + 45, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 65, box.y + box.height / 2);
    await expect(page.locator("[data-line-drag-preview]")).toHaveCount(0);
    await page.mouse.up();
    expect(await lineMoves(page)).toEqual([]);
    await second.click();
    await expect(second).toHaveAttribute("aria-selected", "true");
    await second.dblclick();
    await expect(page).toHaveURL(/\/$/);
    expect((await activeWorkspaceTab(page))?.gameOrigin).toMatchObject({ gameNumber: 1 });
});

test("files-preview: returning to Library restores a late game after section headings load", async ({
    page,
    mockScenario,
}) => {
    const file = { ...repertoireFile, gameCount: 40 };
    const games = Array.from({ length: file.gameCount }, (_, index) => ({
        pgn: `[White "White ${index + 1}"]\n[Black "Black ${index + 1}"]\n[Section "Section ${index + 1}"]\n\n1. e4 c5 *`,
        stamp: String(index + 1).padStart(64, "0"),
        revision: "remembered-file-revision",
        present: true,
    }));
    const tokens = Object.fromEntries(
        games.map((game, index) => [
            game.pgn,
            [
                ...["White", "Black", "Section"].map((tag) => ({
                    type: "Header",
                    value: { tag, value: `${tag} ${index + 1}` },
                })),
                { type: "San", value: "e4" },
                { type: "San", value: "c5" },
                { type: "Outcome", value: "*" },
            ],
        ]),
    );
    await mockScenario({
        commands: filesWorkspaceCommands([], {
            list_file_workspace: { result: { entries: [file], unread: [] } },
            read_games: { pgnGames: games },
            read_game: { pgnGames: games },
            file_revision: { result: "remembered-file-revision" },
            lex_pgn: { pgnTokens: tokens, delay: 80 },
        }),
    });
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose collection", exact: true }).click();
    await selectFilesTreeRow(page, file.name);
    const list = page.getByRole("listbox", { name: "Games", exact: true });
    const viewport = list.locator("..");
    const late = list.getByRole("option", { name: /White 40 - Black 40/ });
    // Reach the last game through user scrolling before opening it.
    await expect(async () => {
        await viewport.hover();
        await page.mouse.wheel(0, 3000);
        await expect(late).toBeInViewport({ ratio: 1 });
    }).toPass();
    await late.dblclick();
    await expect(page).toHaveURL(/\/$/);
    expect((await activeWorkspaceTab(page))?.gameOrigin).toMatchObject({ gameNumber: 39 });
    await page.locator("nav").getByRole("link", { name: "Library", exact: true }).click();
    await expect(page.getByRole("treeitem", { name: file.name, exact: true })).toHaveAttribute(
        "aria-selected",
        "true",
    );
    await expect(late).toHaveAttribute("aria-selected", "true");
    await expect(late).toHaveAttribute("aria-description", "Section 40");
    await expectCellStaysInViewport(late);
});

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
    await expectCellStaysInViewport(currentCell);
}

async function expectCellStaysInViewport(cell: Locator) {
    const isInsideViewport = () =>
        cell.evaluate((cell) => {
            const viewport = cell.closest(".mantine-ScrollArea-viewport");
            if (viewport === null) return false;
            const bounds = cell.getBoundingClientRect();
            const top = viewport.getBoundingClientRect().top + viewport.clientTop;
            return bounds.top >= top && bounds.bottom <= top + viewport.clientHeight;
        });
    await expect.poll(isInsideViewport).toBe(true);
    // Let heading loads, layout updates and queued retries settle without scrolling.
    await cell.page().evaluate(async (settleFrames) => {
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

test("files-preview: a move key takes focus off the clicked row, Enter before it still opens", async ({
    page,
    mockScenario,
}) => {
    await mockScenario({
        commands: filesWorkspaceCommands([[gameOpeningFixture.file]], gameOpeningCommands),
    });
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose collection", exact: true }).click();
    await selectFilesTreeRow(page, gameOpeningFixture.file.name);
    const second = page.getByRole("option", { name: /Second White - Second Black/ });
    await second.click();
    await expect(second).toHaveAttribute("aria-selected", "true");
    await expect(second).toBeFocused();
    const firstMove = page.getByRole("button", { name: "d4", exact: true });
    await expect(firstMove).toBeVisible();
    const moveBackground = () =>
        firstMove.evaluate((cell) => cell.style.getPropertyValue("--light-bg"));
    expect(await moveBackground()).toBe("transparent");

    await page.keyboard.press("ArrowRight");

    await expect.poll(moveBackground).not.toBe("transparent");
    await expect(second).not.toBeFocused();
    expect(await second.evaluate((row) => row.matches(":focus-visible"))).toBe(false);

    await second.click();
    await expect(second).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("tab", { name: /Second White - Second Black/ })).toBeVisible();
});

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

test("files-preview: a repertoire line shows its section icon where it can be found", async ({
    page,
    mockScenario,
    capture,
}) => {
    const file = { ...repertoireFile, metadata: { type: "repertoire" as const, tags: [] } };
    await mockScenario({ commands: filesWorkspaceCommands([[file]], pgnFileCommands) });
    await page.goto("/library");
    await page.getByRole("button", { name: /choose collection/i }).click();
    await selectFilesTreeRow(page, file.name);
    const rows = page.getByRole("option");
    const iconOf = (row: Locator) =>
        row.getByRole("button", { name: "Start section here", exact: true });
    await expect(iconOf(rows.nth(0))).toHaveCSS("opacity", "1");
    await expect(iconOf(rows.nth(1))).toHaveCSS("opacity", "0");
    await capture("files-section-icon");

    await rows.nth(1).hover();
    await expect(iconOf(rows.nth(1))).toHaveCSS("opacity", "1");
    await iconOf(rows.nth(1)).click();
    const dialog = page.getByRole("dialog", { name: "Section", exact: true });
    await expect(dialog.getByRole("textbox", { name: "Name" })).toBeVisible();
    await capture("files-section-dialog");
    await expect(rows.nth(0)).toHaveAttribute("aria-selected", "true");
    await expect(rows.nth(1)).toHaveAttribute("aria-selected", "false");
});

test("files-preview: a section's icon opens its choices inside the window", async ({
    page,
    mockScenario,
}) => {
    const file = { ...repertoireFile, metadata: { type: "repertoire" as const, tags: [] } };
    const tokens = [
        { type: "Header", value: { tag: "Section", value: "mit g3" } },
        ...(pgnFileCommands.lex_pgn.result as unknown[]),
    ];
    await mockScenario({
        commands: filesWorkspaceCommands([[file]], {
            ...pgnFileCommands,
            lex_pgn: { result: tokens },
        }),
    });
    await page.goto("/library");
    await page.getByRole("button", { name: /choose collection/i }).click();
    await selectFilesTreeRow(page, file.name);
    await expect(page.getByText("mit g3").first()).toBeVisible();
    await page
        .getByRole("option")
        .first()
        .getByRole("button", { name: "Section", exact: true })
        .click();
    for (const name of ["Rename section", "Remove section"]) {
        await expect(page.getByRole("menuitem", { name, exact: true })).toBeInViewport({
            ratio: 1,
        });
    }
    // The choice replaces the menu with its dialog, so the item click must not end the editor.
    await page.getByRole("menuitem", { name: "Rename section", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Section", exact: true });
    await expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue("mit g3");
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

test("files-preview: a right click on the board offers flip and copy FEN", async ({
    page,
    mockScenario,
    assertNoHorizontalOverflow,
    capture,
}) => {
    await mockScenario({ commands: filesWorkspaceCommands([[repertoireFile]], pgnFileCommands) });
    await page.addInitScript(() => {
        const copied: string[] = [];
        Object.assign(window, { __copied: copied });
        Object.defineProperty(navigator, "clipboard", {
            value: { writeText: async (text: string) => void copied.push(text) },
        });
    });
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose collection", exact: true }).click();
    await selectFilesTreeRow(page, repertoireFile.name);
    const board = page.locator("cg-board");
    await expect(board).toBeVisible();
    const flip = page.getByRole("menuitem", { name: "Flip board", exact: true });
    const copy = page.getByRole("menuitem", { name: "Copy FEN", exact: true });
    const boardBox = (await board.boundingBox())!;
    const orientation = page.locator(".cg-wrap");
    const menu = page.getByRole("menu");
    const menuLeft = async () => Math.round((await menu.boundingBox())?.x ?? -1);

    await board.click({ button: "right" });
    await expect(flip).toBeInViewport({ ratio: 1 });
    await expect(copy).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("menuitem")).toHaveCount(2);
    await assertNoHorizontalOverflow();
    await capture("files-preview-board-menu");
    await expect.poll(menuLeft).toBeGreaterThan(0);
    const centreLeft = await menuLeft();

    await page.getByRole("heading", { name: "Library", exact: true }).click();
    await expect(flip).toHaveCount(0);

    // Opens where the pointer is, also close to the window's lower edge.
    // By coordinates: Chessground's shape layer covers the corner, and a real click bubbles past it.
    await page.mouse.click(boardBox.x + boardBox.width - 4, boardBox.y + boardBox.height - 4, {
        button: "right",
    });
    await expect(flip).toBeInViewport({ ratio: 1 });
    await expect(copy).toBeInViewport({ ratio: 1 });
    await expect.poll(menuLeft).toBeGreaterThan(centreLeft);

    // A right click elsewhere moves the open menu there.
    await board.click({ button: "right" });
    await expect.poll(menuLeft).toBe(centreLeft);

    await expect(orientation).toHaveClass(/orientation-white/);
    await flip.click();
    await expect(flip).toHaveCount(0);
    await expect(orientation).toHaveClass(/orientation-black/);

    await board.click({ button: "right" });
    await copy.click();
    await expect(copy).toHaveCount(0);
    expect(
        await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied),
    ).toEqual(["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"]);
    await expect(page.locator("svg.cg-shapes g[cgHash] circle")).toHaveCount(0);
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
