import type { Page } from "@playwright/test";
import type { Token } from "../src/bindings/generated";
import {
    expect,
    filesWorkspaceCommands,
    filesWorkspaceFixture,
    pgnFileCommands,
    selectFilesTreeRow,
    test,
    toggleNotationViewOption,
    type MockScenario,
} from "./fixtures";

// A legal 120-ply game (generated), long enough to scroll the notation many times over.
const SANS = [
    "d4",
    "c6",
    "b3",
    "Nh6",
    "e3",
    "e6",
    "h3",
    "Bd6",
    "Nc3",
    "Rg8",
    "Qf3",
    "Bc5",
    "d5",
    "Bb4",
    "Ne2",
    "Bxc3+",
    "Bd2",
    "Na6",
    "dxc6",
    "Qb6",
    "Qd5",
    "Bxd2+",
    "Kxd2",
    "e5",
    "c3",
    "Kd8",
    "Rd1",
    "Kc7",
    "Rh2",
    "e4",
    "Qb5",
    "f6",
    "Qg5",
    "g6",
    "Qf5",
    "dxc6",
    "Rb1",
    "Qc5",
    "a3",
    "Kb6",
    "f3",
    "Qe5",
    "Qxe5",
    "f5",
    "Qc7+",
    "Kc5",
    "Ke1",
    "Nf7",
    "h4",
    "Ne5",
    "Nd4",
    "Rd8",
    "Nxf5",
    "gxf5",
    "Qd6+",
    "Kxd6",
    "Bd3",
    "Kc7",
    "Kd2",
    "Nxd3",
    "g4",
    "Kb6",
    "Ke2",
    "f4",
    "Kf1",
    "Nb2",
    "b4",
    "Nxb4",
    "Re1",
    "Rd6",
    "Rg2",
    "Re6",
    "g5",
    "Nd5",
    "Rd2",
    "Ka5",
    "Rh2",
    "Rg6",
    "Kg1",
    "Ka4",
    "Rd2",
    "Nd1",
    "Kh2",
    "b6",
    "Kh1",
    "Ne7",
    "Rb2",
    "Rg8",
    "Kh2",
    "c5",
    "exf4",
    "b5",
    "Rb4+",
    "Kxa3",
    "f5",
    "Be6",
    "c4",
    "e3",
    "h5",
    "Bxf5",
    "Re2",
    "a5",
    "Ra4+",
    "Kxa4",
    "Re1",
    "Bg6",
    "Rf1",
    "Rh8",
    "Rh1",
    "Ng8",
    "Kh3",
    "Nf6",
    "cxb5",
    "Rhg8",
    "Rg1",
    "c4",
    "f4",
    "Ne8",
    "f5",
    "h6",
];
// GameNotation's follow margin: three 32 px rows, at most a quarter of the viewport.
const FOLLOW_MARGIN_PX = 96;
const FOLLOW_MARGIN_PANEL_DIVISOR = 4;
const LAYOUT_TOLERANCE_PX = 2;
// Settle frames GameNotation may still spend after a turn before the list holds still.
const SETTLE_FRAMES = 6;

const tokens: Token[] = [
    { type: "Header", value: { tag: "Event", value: "Follow scroll" } },
    { type: "Header", value: { tag: "White", value: "White" } },
    { type: "Header", value: { tag: "Black", value: "Black" } },
    { type: "Header", value: { tag: "Result", value: "*" } },
    ...SANS.map((value): Token => ({ type: "San", value })),
    { type: "Outcome", value: "*" },
];

type FollowState = { top: number; height: number; cellTop: number; cellBottom: number };

async function openLongGame(page: Page, mockScenario: (scenario: MockScenario) => Promise<void>) {
    await mockScenario({
        commands: filesWorkspaceCommands([[filesWorkspaceFixture.pgnFile]], {
            ...pgnFileCommands,
            lex_pgn: { pgnTokens: { [filesWorkspaceFixture.pgnGame]: tokens } },
        }),
    });
    await page.goto("/library");
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    await selectFilesTreeRow(page, filesWorkspaceFixture.pgnFile.name);
    await page.getByRole("button", { name: "Open game", exact: true }).click();
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("button", { name: "View options", exact: true })).toBeVisible();
}

/** Waits a few frames for the follow scroll to settle, then reads the list and current cell. */
async function followState(page: Page, frames = SETTLE_FRAMES): Promise<FollowState | null> {
    return page.evaluate(async (frames) => {
        for (let i = 0; i < frames; i += 1) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        const viewport = [
            ...document.querySelectorAll<HTMLElement>(".mantine-ScrollArea-viewport"),
        ].find((element) => element.querySelector("[data-index]"));
        const cell = viewport?.querySelector<HTMLElement>('[data-notation-current="true"]');
        if (!viewport || !cell) return null;
        const viewportTop = viewport.getBoundingClientRect().top + viewport.clientTop;
        const bounds = cell.getBoundingClientRect();
        return {
            top: viewport.scrollTop,
            height: viewport.clientHeight,
            cellTop: bounds.top - viewportTop,
            cellBottom: bounds.bottom - viewportTop,
        };
    }, frames);
}

function margin(height: number) {
    return Math.min(FOLLOW_MARGIN_PX, Math.floor(height / FOLLOW_MARGIN_PANEL_DIVISOR));
}

function expectVisible(state: FollowState | null, label: string): asserts state is FollowState {
    expect(state, `${label}: current move rendered`).not.toBeNull();
    expect(state!.cellTop, `${label}: current move below the top edge`).toBeGreaterThanOrEqual(
        -LAYOUT_TOLERANCE_PX,
    );
    expect(state!.cellBottom, `${label}: current move above the bottom edge`).toBeLessThanOrEqual(
        state!.height + LAYOUT_TOLERANCE_PX,
    );
}

// The notation draws pieces as figurines, so match the move without its piece letter.
function moveText(ply: number) {
    const square = SANS[ply - 1].replace(/[+#]/g, "").replace(/^[KQRBN]/, "");
    return new RegExp(square.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

async function stepTo(page: Page, key: "ArrowRight" | "ArrowLeft", ply: number, label: string) {
    await page.keyboard.press(key);
    await expect(
        page.locator('[data-notation-current="true"] button').first(),
        `${label}: current move`,
    ).toHaveText(moveText(ply));
}

for (const view of ["table", "inline"] as const) {
    test(`notation-follow-scroll: ${view} view turns the page only at the edges and never loses the current move`, async ({
        page,
        mockScenario,
    }) => {
        // About 160 steps with a settle wait each take ~45 s in WebKit, the default limit.
        test.slow();
        await page.emulateMedia({ reducedMotion: "reduce" });
        await openLongGame(page, mockScenario);
        if (view === "table") await toggleNotationViewOption(page, "Table view");
        // Focus the page outside the notation (the top-left corner of the window) for the keys.
        await page.mouse.click(5, 5);

        let previous: FollowState | null = null;
        let turns = 0;
        for (let ply = 1; ply <= SANS.length; ply += 1) {
            await stepTo(page, "ArrowRight", ply, `forward ${ply}`);
            const state = await followState(page);
            expectVisible(state, `forward ${ply}`);
            if (previous && Math.abs(state.top - previous.top) > LAYOUT_TOLERANCE_PX) {
                turns += 1;
                // A forward turn puts the move one margin below the top edge (or the list ends).
                const atEnd =
                    state.top + state.height >= (await scrollHeight(page)) - LAYOUT_TOLERANCE_PX;
                if (!atEnd) {
                    expect(state.cellTop, `forward ${ply}: turned to the top margin`).toBeCloseTo(
                        margin(state.height),
                        -1,
                    );
                }
            }
            previous = state;
        }
        // Re-centring would move the list on every row; page turns move it a few times only.
        expect(turns, "forward page turns").toBeGreaterThan(0);
        expect(turns, "forward page turns").toBeLessThan(SANS.length / 6);

        let backTurns = 0;
        for (let ply = SANS.length - 1; ply >= SANS.length - 40; ply -= 1) {
            await stepTo(page, "ArrowLeft", ply, `backward ${ply}`);
            const state = await followState(page);
            expectVisible(state, `backward ${ply}`);
            if (Math.abs(state.top - previous!.top) > LAYOUT_TOLERANCE_PX) {
                backTurns += 1;
                if (state.top > LAYOUT_TOLERANCE_PX) {
                    expect(
                        state.cellBottom,
                        `backward ${ply}: turned to the bottom margin`,
                    ).toBeCloseTo(state.height - margin(state.height), -1);
                }
            }
            previous = state;
        }
        expect(backTurns, "backward page turns").toBeLessThan(40 / 4);
        if (view === "table") expect(backTurns, "backward page turns").toBeGreaterThan(0);

        // A click on the next move once it sits fully visible in the bottom margin does not scroll
        // (a one-ply step that a key press would turn the page for).
        await page.mouse.click(5, 5);
        await page.keyboard.press("Shift+ArrowUp");
        let clickPly = 0;
        let next: NextMove | null = null;
        for (let ply = 1; ply < SANS.length; ply += 1) {
            await followState(page);
            next = await nextMove(page);
            if (next && next.bottom > next.height - margin(next.height)) {
                clickPly = ply;
                break;
            }
            await stepTo(page, "ArrowRight", ply, `to the margin ${ply}`);
        }
        expect(next, "the next move reached the bottom margin").not.toBeNull();
        expect(next!.bottom, "the next move is fully visible").toBeLessThanOrEqual(next!.height);
        const beforeClick = await followState(page);
        await page.mouse.click(next!.x, next!.y);
        await expect(
            page.locator('[data-notation-current="true"] button').first(),
            "the click moved to the next move",
        ).toHaveText(moveText(clickPly));
        const afterClick = await followState(page);
        expectVisible(afterClick, "after click");
        expect(afterClick.top, "a click on a visible move keeps the list still").toBeCloseTo(
            beforeClick!.top,
            0,
        );

        // Go to end shows the last move.
        await page.mouse.click(5, 5);
        await page.keyboard.press("Shift+ArrowDown");
        await expect(page.locator('[data-notation-current="true"] button').first()).toHaveText(
            moveText(SANS.length),
        );
        expectVisible(await followState(page), "end");
    });
}

test("notation-follow-scroll: held arrow key keeps the list with the board while animating", async ({
    page,
    mockScenario,
}) => {
    await openLongGame(page, mockScenario);
    await toggleNotationViewOption(page, "Table view");
    await page.mouse.click(5, 5);
    for (let ply = 1; ply <= 60; ply += 1) await page.keyboard.press("ArrowRight", { delay: 0 });
    await expect(page.locator('[data-notation-current="true"] button').first()).toHaveText(
        moveText(60),
    );
    // One frame after the last key: the interrupted turns snapped as the keys came, so the list
    // is already with the board instead of catching up over several animations.
    expectVisible(await followState(page, 1), "after 60 fast steps");
});

type NextMove = { x: number; y: number; bottom: number; height: number };

/** The move button after the current one in notation order, relative to the viewport. */
async function nextMove(page: Page): Promise<NextMove | null> {
    return page.evaluate(() => {
        const viewport = [
            ...document.querySelectorAll<HTMLElement>(".mantine-ScrollArea-viewport"),
        ].find((element) => element.querySelector("[data-index]"));
        if (!viewport) return null;
        const buttons = [...viewport.querySelectorAll<HTMLElement>("[data-index] button")];
        const current = viewport.querySelector('[data-notation-current="true"] button');
        const button = buttons[current ? buttons.indexOf(current as HTMLElement) + 1 : 0];
        if (!button) return null;
        const viewportTop = viewport.getBoundingClientRect().top + viewport.clientTop;
        const bounds = button.getBoundingClientRect();
        return {
            x: bounds.x + bounds.width / 2,
            y: bounds.y + bounds.height / 2,
            bottom: bounds.bottom - viewportTop,
            height: viewport.clientHeight,
        };
    });
}

async function scrollHeight(page: Page) {
    return page.evaluate(
        () =>
            [...document.querySelectorAll<HTMLElement>(".mantine-ScrollArea-viewport")].find(
                (element) => element.querySelector("[data-index]"),
            )!.scrollHeight,
    );
}
