import type { Locator, Page } from "@playwright/test";
import type { Token } from "../src/bindings/generated";
import {
    contrastRatio,
    expect,
    filesWorkspaceCommands,
    filesWorkspaceFixture,
    pgnFileCommands,
    selectFilesTreeRow,
    test,
    waitForFontsSettled,
    waitForScrollAreaScrollbarsHidden,
    type MockScenario,
    wheelBoardStackTo,
    wheelColumnTo,
} from "./fixtures";

const MAIN_SAN = "e4";
const VARIATION_SAN = "Nc3";
const CURRENT_VARIATION_SAN = "d3";
const NAG_MAIN_SAN = "Nf3?";
const NAG_VARIATION_SAN = "f5?";
const MAIN_COMMENT = "Main-line comment";
const VARIATION_COMMENT = "Variation comment";
// Keep the pointer and selected move clear of the viewport's bottom/top edges.
const SCROLL_CLEARANCE_PX = 40;

const hierarchyTokens: Token[] = [
    { type: "Header", value: { tag: "Event", value: "E2E" } },
    { type: "Header", value: { tag: "White", value: "Weiss" } },
    { type: "Header", value: { tag: "Black", value: "Schwarz" } },
    { type: "Header", value: { tag: "Result", value: "*" } },
    { type: "San", value: "e4" },
    { type: "San", value: "e5" },
    { type: "Comment", value: MAIN_COMMENT },
    { type: "San", value: "Nf3" },
    { type: "Nag", value: "$2" },
    { type: "San", value: "Nc6" },
    { type: "San", value: "Bb5" },
    { type: "San", value: "a6" },
    { type: "ParenOpen" },
    { type: "San", value: "f5" },
    { type: "Nag", value: "$2" },
    { type: "Comment", value: VARIATION_COMMENT },
    { type: "San", value: "Nc3" },
    { type: "ParenOpen" },
    { type: "San", value: "d3" },
    { type: "ParenClose" },
    { type: "San", value: "fxe4" },
    { type: "ParenClose" },
    { type: "San", value: "Ba4" },
    { type: "San", value: "Nf6" },
    { type: "Outcome", value: "*" },
];

type HierarchyNames = {
    mainSan: string;
    variationSan: string;
    currentVariationSan: string;
    nagMainSan: string;
    nagVariationSan: string;
    mainComment: string;
    variationComment: string;
};

type HierarchyMetrics = {
    mainSanSize: number;
    variationSanSize: number;
    mainSanWeight: number;
    variationSanWeight: number;
    mainCommentSize: number;
    variationCommentSize: number;
    blockBackground: string;
    inset: string;
    cardBackground: string;
    blockBorder: string;
    borderStrong: string;
    variationSanColor: string;
    dimmed: string;
    mainSanColor: string;
    nagVariationColor: string;
    nagMainColor: string;
    opacities: string[];
    filters: string[];
    currentCellBackground: string;
    otherCellBackground: string;
    scrollWidth: number;
    clientWidth: number;
};

const hierarchyNames: HierarchyNames = {
    mainSan: MAIN_SAN,
    variationSan: VARIATION_SAN,
    currentVariationSan: CURRENT_VARIATION_SAN,
    nagMainSan: NAG_MAIN_SAN,
    nagVariationSan: NAG_VARIATION_SAN,
    mainComment: MAIN_COMMENT,
    variationComment: VARIATION_COMMENT,
};

async function mockHierarchyGame(
    page: Page,
    mockScenario: (scenario: MockScenario) => Promise<void>,
    options: { colorScheme?: "light" | "dark" } = {},
) {
    await mockScenario({
        commands: filesWorkspaceCommands([[filesWorkspaceFixture.pgnFile]], {
            ...pgnFileCommands,
            lex_pgn: {
                pgnTokens: {
                    [filesWorkspaceFixture.pgnGame]: hierarchyTokens,
                },
            },
        }),
    });
    if (options.colorScheme) {
        await page.emulateMedia({ colorScheme: options.colorScheme });
        await page.addInitScript(
            (scheme) => localStorage.setItem("mantine-color-scheme", scheme),
            options.colorScheme,
        );
    }
    await page.addInitScript(() => {
        localStorage.setItem("letters", JSON.stringify("letters"));
    });
}

function notationViewport(page: Page) {
    return page.locator(".mantine-ScrollArea-viewport").filter({
        has: page.getByRole("button", { name: MAIN_SAN, exact: true }),
    });
}

async function openLibraryFile(page: Page) {
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose collection", exact: true }).click();
    await selectFilesTreeRow(page, filesWorkspaceFixture.pgnFile.name);
}

async function openHierarchyGame(
    page: Page,
    mockScenario: (scenario: MockScenario) => Promise<void>,
    colorScheme?: "light" | "dark",
) {
    await mockHierarchyGame(page, mockScenario, { colorScheme });
    await openLibraryFile(page);
    await page.getByRole("button", { name: "Open game", exact: true }).click();
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("button", { name: "Table view", exact: true })).toBeVisible();
    const notation = notationViewport(page);
    await expect(notation).toHaveCount(1);
    await expect(
        notation.getByRole("button", { name: NAG_VARIATION_SAN, exact: true }),
    ).toBeVisible();
    await expect(notation.getByText(MAIN_COMMENT)).toBeVisible();
    await expect(notation.getByText(VARIATION_COMMENT)).toBeVisible();
    await wheelBoardStackTo(page, page.locator("#bottomRight"));
    await wheelColumnTo(
        page,
        page.getByRole("button", { name: "Go to end", exact: true }).locator("../.."),
        notation,
    );
    const current = notation.getByRole("button", { name: CURRENT_VARIATION_SAN, exact: true });
    const viewBox = (await notation.boundingBox())!;
    const currentBox = (await current.boundingBox())!;
    await page.mouse.move(
        viewBox.x + viewBox.width / 2,
        Math.min(viewBox.y + viewBox.height / 2, page.viewportSize()!.height - SCROLL_CLEARANCE_PX),
    );
    await page.mouse.wheel(0, currentBox.y - viewBox.y - SCROLL_CLEARANCE_PX);
    await current.click();
    await expect(notation.locator('[data-notation-current="true"] button')).toHaveText(
        CURRENT_VARIATION_SAN,
    );
    await waitForFontsSettled(page);
    await page.mouse.move(0, 0);
    return notation;
}

async function assertNotationNoOverflow(notation: Locator, view: "inline" | "table") {
    await expect(
        notation.getByRole("button", { name: MAIN_SAN, exact: true }),
        `${view} notation has mounted move rows`,
    ).toBeVisible();
    const box = await notation.evaluate((viewport) => {
        const edge = viewport.getBoundingClientRect().right;
        const overflowing = [...viewport.querySelectorAll("[data-index], table, button")].flatMap(
            (el) => {
                const rect = el.getBoundingClientRect();
                if (rect.right <= edge + 0.5) return [];
                return [
                    {
                        tag: el.tagName,
                        text: (el.textContent ?? "").trim().slice(0, 40),
                        overflowPx: Math.round(rect.right - edge),
                    },
                ];
            },
        );
        return {
            scrollWidth: viewport.scrollWidth,
            clientWidth: viewport.clientWidth,
            overflowing,
        };
    });
    expect(
        box.scrollWidth,
        `${view} notation viewport overflow ${JSON.stringify(box)}`,
    ).toBeLessThanOrEqual(box.clientWidth);
}

async function showTableView(page: Page, notation: Locator) {
    await page.getByRole("button", { name: "Table view", exact: true }).click();
    await expect(
        notation.locator("td").filter({
            has: page.getByRole("button", { name: MAIN_SAN, exact: true }),
        }),
    ).toHaveCount(1);
    await waitForFontsSettled(page);
    await page.mouse.move(0, 0);
}

async function measureHierarchy(notation: Locator): Promise<HierarchyMetrics> {
    return notation.evaluate((viewport, names: HierarchyNames) => {
        const buttonByName = (name: string) => {
            const match = [...viewport.querySelectorAll("button")].find(
                (button) => button.textContent === name,
            );
            if (!match) throw new Error(`missing SAN button ${name}`);
            return match;
        };
        const textNode = (text: string) => {
            const match = [...viewport.querySelectorAll("*")].find(
                (el) => el.textContent === text && el.children.length === 0,
            );
            if (!match) throw new Error(`missing comment ${text}`);
            return match;
        };
        const closestClass = (el: Element, fragment: string) => {
            let node: Element | null = el;
            while (node) {
                if ([...node.classList].some((cls) => cls.includes(fragment))) {
                    return node as HTMLElement;
                }
                node = node.parentElement;
            }
            return null;
        };
        const resolveVar = (
            variable: string,
            property: "backgroundColor" | "color" | "borderLeftColor",
        ) => {
            const probe = document.createElement("span");
            probe.style.backgroundColor = `var(${variable})`;
            probe.style.color = `var(${variable})`;
            probe.style.borderLeftColor = `var(${variable})`;
            probe.style.position = "absolute";
            probe.style.visibility = "hidden";
            viewport.appendChild(probe);
            const value = getComputedStyle(probe)[property];
            probe.remove();
            return value;
        };
        const mainSan = buttonByName(names.mainSan);
        const variationSan = buttonByName(names.variationSan);
        const currentSan = buttonByName(names.currentVariationSan);
        const nagMain = buttonByName(names.nagMainSan);
        const nagVariation = buttonByName(names.nagVariationSan);
        const mainComment = textNode(names.mainComment);
        const variationComment = textNode(names.variationComment);
        const block = closestClass(variationSan, "variationBlock");
        if (!block) throw new Error("variation SAN is not inside a variation block");
        if (closestClass(mainSan, "variationBlock")) {
            throw new Error("main-line SAN is inside a variation block");
        }
        const card = viewport.closest(".mantine-Paper-root");
        if (!(card instanceof HTMLElement)) throw new Error("missing notation card");
        const currentWrapper = currentSan.closest("[data-notation-current='true']");
        if (!(currentWrapper instanceof HTMLElement)) {
            throw new Error("current variation move is not marked");
        }

        const chain: string[] = [];
        const filters: string[] = [];
        let node: HTMLElement | null = block;
        while (node) {
            const style = getComputedStyle(node);
            chain.push(style.opacity);
            filters.push(style.filter);
            if (node === viewport) break;
            node = node.parentElement;
        }
        if (node !== viewport) throw new Error("variation block is outside the notation viewport");

        const variationSanColor = getComputedStyle(variationSan).color;
        const blockBackground = getComputedStyle(block).backgroundColor;
        return {
            mainSanSize: parseFloat(getComputedStyle(mainSan).fontSize),
            variationSanSize: parseFloat(getComputedStyle(variationSan).fontSize),
            mainSanWeight: parseFloat(getComputedStyle(mainSan).fontWeight),
            variationSanWeight: parseFloat(getComputedStyle(variationSan).fontWeight),
            mainCommentSize: parseFloat(getComputedStyle(mainComment).fontSize),
            variationCommentSize: parseFloat(getComputedStyle(variationComment).fontSize),
            blockBackground,
            inset: resolveVar("--cf-surface-inset", "backgroundColor"),
            cardBackground: getComputedStyle(card).backgroundColor,
            blockBorder: getComputedStyle(block).borderLeftColor,
            borderStrong: resolveVar("--cf-border-strong", "borderLeftColor"),
            variationSanColor,
            dimmed: resolveVar("--mantine-color-dimmed", "color"),
            mainSanColor: getComputedStyle(mainSan).color,
            nagVariationColor: getComputedStyle(nagVariation).color,
            nagMainColor: getComputedStyle(nagMain).color,
            opacities: chain,
            filters,
            currentCellBackground: getComputedStyle(currentSan).backgroundColor,
            otherCellBackground: getComputedStyle(variationSan).backgroundColor,
            scrollWidth: viewport.scrollWidth,
            clientWidth: viewport.clientWidth,
        };
    }, hierarchyNames);
}

function assertHierarchyStyles(metrics: HierarchyMetrics, view: "inline" | "table") {
    expect(metrics.variationSanSize, `${view} variation SAN font-size`).toBeLessThan(
        metrics.mainSanSize,
    );
    expect(metrics.variationSanWeight, `${view} variation SAN font-weight`).toBeLessThan(
        metrics.mainSanWeight,
    );
    expect(metrics.variationCommentSize, `${view} variation comment font-size`).toBeLessThan(
        metrics.mainCommentSize,
    );
    expect(metrics.blockBackground, `${view} variation block background`).toBe(metrics.inset);
    expect(metrics.blockBackground, `${view} variation block differs from card`).not.toBe(
        metrics.cardBackground,
    );
    expect(metrics.blockBorder, `${view} variation block left border`).toBe(metrics.borderStrong);
    expect(metrics.variationSanColor, `${view} unannotated variation SAN`).toBe(metrics.dimmed);
    expect(metrics.variationSanColor, `${view} variation SAN differs from main-line SAN`).not.toBe(
        metrics.mainSanColor,
    );
    expect(
        contrastRatio(metrics.variationSanColor, [metrics.blockBackground]),
        `${view} variation SAN contrast`,
    ).toBeGreaterThanOrEqual(4.5);
    expect(metrics.nagVariationColor, `${view} NAG $2 variation SAN`).toBe(metrics.nagMainColor);
    expect(metrics.opacities, `${view} variation block opacity chain`).toEqual(
        metrics.opacities.map(() => "1"),
    );
    expect(metrics.filters, `${view} variation block filter chain`).toEqual(
        metrics.filters.map(() => "none"),
    );
    expect(
        metrics.currentCellBackground,
        `${view} current variation cell is not transparent`,
    ).not.toBe("rgba(0, 0, 0, 0)");
    expect(
        metrics.currentCellBackground,
        `${view} current variation cell differs from a non-current variation cell`,
    ).not.toBe(metrics.otherCellBackground);
    expect(metrics.scrollWidth, `${view} notation viewport overflow`).toBeLessThanOrEqual(
        metrics.clientWidth,
    );
}

function notationCard(page: Page) {
    return page.locator("#bottomRight .mantine-Paper-root").filter({
        has: page.getByRole("button", { name: MAIN_SAN, exact: true }),
    });
}

for (const colorScheme of ["light", "dark"] as const) {
    test(`notation-hierarchy: inline and table in ${colorScheme}`, async ({
        page,
        mockScenario,
        capture,
    }) => {
        const notation = await openHierarchyGame(page, mockScenario, colorScheme);
        const inline = await measureHierarchy(notation);
        assertHierarchyStyles(inline, "inline");
        await capture(`notation-hierarchy-inline-${colorScheme}`);
        await waitForScrollAreaScrollbarsHidden(page);
        await expect
            .soft(notationCard(page))
            .toHaveScreenshot(`notation-hierarchy-inline-${colorScheme}.png`, {
                animations: "disabled",
            });

        await showTableView(page, notation);
        const table = await measureHierarchy(notation);
        assertHierarchyStyles(table, "table");
        await capture(`notation-hierarchy-table-${colorScheme}`);
        await waitForScrollAreaScrollbarsHidden(page);
        await expect
            .soft(notationCard(page))
            .toHaveScreenshot(`notation-hierarchy-table-${colorScheme}.png`, {
                animations: "disabled",
            });
    });
}

test("notation-hierarchy: overflow-only in both views", async ({ page, mockScenario }) => {
    const notation = await openHierarchyGame(page, mockScenario);
    await assertNotationNoOverflow(notation, "inline");
    await showTableView(page, notation);
    await assertNotationNoOverflow(notation, "table");
});

async function assertStackedBoardGeometry(page: Page, label: string) {
    await expect(page.locator('[data-board-layout="stacked"]')).toHaveCount(1);
    await waitForFontsSettled(page);
    const geometry = await page.evaluate(() => {
        const target = document.getElementById("left")!;
        const host = target.parentElement!;
        const hostStyle = getComputedStyle(host);
        const stack = host.parentElement!;
        const stackStyle = getComputedStyle(stack);
        const card = target.firstElementChild!;
        const tile = target.getBoundingClientRect();
        const cardBox = card.getBoundingClientRect();
        const style = getComputedStyle(card);
        const square = target.querySelector(".cg-wrap")!.getBoundingClientRect();
        const content = [...target.querySelectorAll("[data-board-surface], [data-board-bar]")].map(
            (element) => element.getBoundingClientRect(),
        );
        const contentHeight =
            Math.max(...content.map((box) => box.bottom)) -
            Math.min(...content.map((box) => box.top));
        const tileInnerHeight =
            cardBox.height -
            parseFloat(style.borderTopWidth) -
            parseFloat(style.borderBottomWidth) -
            parseFloat(style.paddingTop) -
            parseFloat(style.paddingBottom);
        return {
            tileWidth: tile.width,
            availableWidth:
                stack.clientWidth -
                parseFloat(stackStyle.paddingLeft) -
                parseFloat(stackStyle.paddingRight) -
                parseFloat(hostStyle.marginLeft) -
                parseFloat(hostStyle.marginRight),
            tileInnerWidth: card.clientWidth,
            tileInnerHeight,
            contentHeight,
            emptySpace: Math.max(0, tileInnerHeight - contentHeight),
            rootFont: parseFloat(getComputedStyle(document.documentElement).fontSize),
            squareWidth: square.width,
            squareHeight: square.height,
            paintedSquareWidth: target.querySelector("cg-board")!.getBoundingClientRect().width,
            scrollWidth: document.documentElement.scrollWidth,
            viewport: innerWidth,
        };
    });
    console.log(`${label} geometry ${JSON.stringify(geometry)}`);
    expect(Math.abs(geometry.tileWidth - geometry.availableWidth)).toBeLessThanOrEqual(1);
    expect(geometry.squareWidth).toBeGreaterThanOrEqual(geometry.tileWidth * 0.9);
    expect(geometry.paintedSquareWidth).toBeGreaterThanOrEqual(geometry.tileInnerWidth * 0.9);
    expect(Math.abs(geometry.squareWidth - geometry.squareHeight)).toBeLessThanOrEqual(1);
    expect(geometry.contentHeight).toBeLessThanOrEqual(geometry.tileInnerHeight + 1);
    expect(geometry.emptySpace).toBeLessThanOrEqual(geometry.rootFont);
    expect(geometry.scrollWidth).toBe(geometry.viewport);
}

test("notation-hierarchy: overflow-only stacked board fits content at 100%", async ({
    page,
    mockScenario,
}) => {
    await page.setViewportSize({ width: 560, height: 800 });
    await page.addInitScript(() => localStorage.setItem("font-size", "100"));
    await mockHierarchyGame(page, mockScenario);
    await openLibraryFile(page);
    await page.getByRole("button", { name: "Open game", exact: true }).click();
    await expect(page).toHaveURL("/");
    await expect(page.locator("html")).toHaveCSS("font-size", "16px");
    await assertStackedBoardGeometry(page, "560x800/100%");
});

test("notation-hierarchy: overflow-only stacked annotation stays over its square", async ({
    page,
    mockScenario,
}) => {
    await mockScenario({
        commands: filesWorkspaceCommands([[filesWorkspaceFixture.pgnFile]], {
            ...pgnFileCommands,
            lex_pgn: {
                pgnTokens: {
                    [filesWorkspaceFixture.pgnGame]: [
                        { type: "Header", value: { tag: "Result", value: "*" } },
                        { type: "San", value: "a3" },
                        { type: "Nag", value: "$1" },
                        { type: "Outcome", value: "*" },
                    ],
                },
            },
        }),
    });
    await openLibraryFile(page);
    await page.getByRole("button", { name: "Open game", exact: true }).click();
    await expect(page).toHaveURL("/");
    await expect(page.locator('[data-board-layout="stacked"]')).toHaveCount(1);
    await expect(page.locator("html")).toHaveCSS("font-size", "32px");
    await wheelBoardStackTo(page, page.locator("#bottomRight"));
    await page.locator("#bottomRight").getByRole("button", { name: "a3!", exact: true }).click();
    await wheelBoardStackTo(page, page.locator("#left"));
    const hint = page.locator("#left [data-board-annotation-hint]");
    // A visible hint also proves that this tab has comments enabled.
    await expect(hint).toBeVisible();
    await waitForFontsSettled(page);
    const geometry = await hint.evaluate((element) => {
        const hint = element.getBoundingClientRect();
        const board = document.querySelector("#left cg-board")!.getBoundingClientRect();
        // White orientation, a3 is file 0 and row 5 from the top of the painted board.
        const square = {
            left: board.left,
            right: board.left + board.width / 8,
            top: board.top + (5 * board.height) / 8,
            bottom: board.top + (6 * board.height) / 8,
        };
        return {
            hint: { x: hint.x, y: hint.y, width: hint.width, height: hint.height },
            center: { x: hint.x + hint.width / 2, y: hint.y + hint.height / 2 },
            square,
        };
    });
    console.log(`320x720/200% a3! annotation ${JSON.stringify(geometry)}`);
    expect(geometry.center.x).toBeGreaterThanOrEqual(geometry.square.left);
    expect(geometry.center.x).toBeLessThanOrEqual(geometry.square.right);
    expect(geometry.center.y).toBeGreaterThanOrEqual(geometry.square.top);
    expect(geometry.center.y).toBeLessThanOrEqual(geometry.square.bottom);
});

test("notation-hierarchy: overflow-only stacked geometry and wheel reachability", async ({
    page,
    mockScenario,
}) => {
    const tokens: Token[] = [
        { type: "Header", value: { tag: "Result", value: "*" } },
        ...Array.from({ length: 100 }, () =>
            ["Nf3", "Nf6", "Ng1", "Ng8"].flatMap((value): Token[] => [
                { type: "San", value },
                { type: "Comment", value: "Scroll reachability row" },
            ]),
        ).flat(),
        { type: "San", value: "e4" },
        { type: "Outcome", value: "*" },
    ];
    await mockScenario({
        commands: filesWorkspaceCommands([[filesWorkspaceFixture.pgnFile]], {
            ...pgnFileCommands,
            lex_pgn: { pgnTokens: { [filesWorkspaceFixture.pgnGame]: tokens } },
        }),
    });
    await openLibraryFile(page);
    await page.getByRole("button", { name: "Open game", exact: true }).click();
    await expect(page).toHaveURL("/");
    await assertStackedBoardGeometry(page, "320x720/200%");
    for (const id of ["left", "topRight", "bottomRight"]) {
        await expect
            .poll(() =>
                page.locator(`#${id}`).evaluate((element) => {
                    const bounds = element.getBoundingClientRect();
                    let ancestor = element.parentElement;
                    while (ancestor) {
                        const box = ancestor.getBoundingClientRect();
                        if (
                            getComputedStyle(ancestor).overflowX !== "visible" &&
                            (bounds.left < box.left - 1 || bounds.right > box.right + 1)
                        )
                            return false;
                        ancestor = ancestor.parentElement;
                    }
                    return true;
                }),
            )
            .toBe(true);
    }
    await wheelBoardStackTo(page, page.locator("#topRight"));
    const analysis = page.locator("#topRight").getByRole("tab", { name: "Analysis", exact: true });
    await expect(analysis).toBeInViewport();
    expect(
        await analysis
            .locator(".mantine-Tabs-tabLabel")
            .evaluate((label) => label.scrollWidth <= label.clientWidth),
    ).toBe(true);
    const move = page.locator("#bottomRight").getByRole("button", { name: "e4", exact: true });
    await expect(move, "late virtual move starts unmounted").toHaveCount(0);
    await wheelBoardStackTo(page, page.locator("#bottomRight"));
    const viewport = page.locator("#bottomRight .mantine-ScrollArea-viewport").last();
    await wheelColumnTo(
        page,
        page.getByRole("button", { name: "Go to end", exact: true }).locator("../.."),
        viewport,
    );
    const viewportBox = (await viewport.boundingBox())!;
    const stackBox = (await page.locator('[data-board-layout="stacked"]').boundingBox())!;
    const x = viewportBox.x + viewportBox.width / 2;
    const y = Math.max(viewportBox.y, stackBox.y) + 30;
    await page.mouse.move(x, y);
    for (let step = 0; step < 200; step++) {
        if (
            (await move.count()) &&
            (await move.evaluate((element) => {
                const box = element.getBoundingClientRect();
                return element.contains(
                    document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
                );
            }))
        )
            break;
        await page.mouse.wheel(0, 500);
        await page.waitForTimeout(30);
    }
    await expect(move).toBeInViewport();
    const moveBox = (await move.boundingBox())!;
    await page.mouse.click(moveBox.x + moveBox.width / 2, moveBox.y + moveBox.height / 2);
    await expect(page.locator('#bottomRight [data-notation-current="true"] button')).toHaveText(
        "e4",
    );
});

test("notation-hierarchy: arrow down returns to the same fork's main move and stops at the main line end", async ({
    page,
    mockScenario,
}) => {
    const notation = await openHierarchyGame(page, mockScenario);
    const current = notation.locator('[data-notation-current="true"] button');
    await expect(current).toHaveText(CURRENT_VARIATION_SAN);

    // 4.d3 → its fork's main move 4.Nc3 → line end → 3...a6 → main line end → stays.
    for (const expected of [VARIATION_SAN, "fxe4", "a6", "Nf6", "Nf6"]) {
        await page.keyboard.press("ArrowDown");
        await expect(current).toHaveText(expected);
    }
});
