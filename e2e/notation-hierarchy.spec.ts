import type { Locator, Page } from "@playwright/test";
import type { Token } from "../src/bindings/generated";
import {
    expect,
    filesWorkspaceCommands,
    filesWorkspaceFixture,
    pgnFileCommands,
    selectFilesTreeRow,
    test,
    waitForFontsSettled,
    type MockScenario,
} from "./fixtures";

const MAIN_SAN = "e4";
const VARIATION_SAN = "Nc3";
const CURRENT_VARIATION_SAN = "d3";
const NAG_MAIN_SAN = "Nf3?";
const NAG_VARIATION_SAN = "f5?";
const MAIN_COMMENT = "Main-line comment";
const VARIATION_COMMENT = "Variation comment";

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
    contrast: number;
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
    options: { colorScheme?: "light" | "dark"; tableView?: boolean } = {},
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
    await page.addInitScript((tableView) => {
        localStorage.setItem("letters", JSON.stringify("letters"));
        if (tableView) localStorage.setItem("table-view", JSON.stringify(true));
    }, options.tableView === true);
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
    const current = notation.getByRole("button", { name: CURRENT_VARIATION_SAN, exact: true });
    await current.scrollIntoViewIfNeeded();
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

async function openScaledNotation(
    page: Page,
    mockScenario: (scenario: MockScenario) => Promise<void>,
) {
    await mockHierarchyGame(page, mockScenario);
    await openLibraryFile(page);
    await page.getByRole("button", { name: "Open game", exact: true }).click();
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("button", { name: "Table view", exact: true })).toBeVisible();
    const notation = notationViewport(page);
    await expect(notation).toHaveCount(1);
    await waitForFontsSettled(page);
    return notation;
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
        const parseRgb = (color: string): [number, number, number] => {
            const comma = color.match(
                /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*[\d.]+)?\s*\)$/,
            );
            if (comma) return [Number(comma[1]), Number(comma[2]), Number(comma[3])];
            const space = color.match(
                /^rgba?\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*[\d.]+)?\s*\)$/,
            );
            if (space) return [Number(space[1]), Number(space[2]), Number(space[3])];
            const srgb = color.match(
                /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*[\d.]+)?\)$/,
            );
            if (srgb) {
                return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255];
            }
            throw new Error(`unparsed color ${color}`);
        };
        const luminance = (color: string) => {
            const channel = (value: number) => {
                const scaled = value / 255;
                return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
            };
            const [r, g, b] = parseRgb(color);
            return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
        };
        const contrastRatio = (foreground: string, background: string) => {
            const first = luminance(foreground);
            const second = luminance(background);
            const lighter = Math.max(first, second);
            const darker = Math.min(first, second);
            return (lighter + 0.05) / (darker + 0.05);
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
            contrast: contrastRatio(variationSanColor, blockBackground),
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
    expect(metrics.contrast, `${view} variation SAN contrast`).toBeGreaterThanOrEqual(4.5);
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
        await expect
            .soft(notationCard(page))
            .toHaveScreenshot(`notation-hierarchy-inline-${colorScheme}.png`, {
                animations: "disabled",
            });

        await showTableView(page, notation);
        const table = await measureHierarchy(notation);
        assertHierarchyStyles(table, "table");
        await capture(`notation-hierarchy-table-${colorScheme}`);
        await expect
            .soft(notationCard(page))
            .toHaveScreenshot(`notation-hierarchy-table-${colorScheme}.png`, {
                animations: "disabled",
            });
    });
}

test("notation-hierarchy: overflow-only in both views", async ({ page, mockScenario }) => {
    const notation = await openScaledNotation(page, mockScenario);
    await assertNotationNoOverflow(notation, "inline");
    await showTableView(page, notation);
    await assertNotationNoOverflow(notation, "table");
});
