import type { Token } from "../src/bindings/generated";
import {
    contrastRatio,
    expect,
    filesWorkspaceCommands,
    filesWorkspaceFixture,
    paintedText,
    pgnFileCommands,
    playBoardMove,
    selectFilesTreeRow,
    test,
    waitForFontsSettled,
} from "./fixtures";

const tokens: Token[] = [
    { type: "Header", value: { tag: "Result", value: "0-1" } },
    { type: "Header", value: { tag: "Termination", value: "Abandoned" } },
    { type: "San", value: "e4" },
    { type: "San", value: "e5" },
    { type: "Outcome", value: "0-1" },
];

// The game ends at e5 ([%gameend] without an inline termination, so the header's Abandoned still
// reaches the boundary); Nf3? continues the main line as an annotated analysis move.
const analysisTokens: Token[] = [
    { type: "Header", value: { tag: "Result", value: "0-1" } },
    { type: "Header", value: { tag: "Termination", value: "Abandoned" } },
    { type: "San", value: "e4" },
    { type: "San", value: "e5" },
    { type: "Comment", value: "[%gameend]" },
    { type: "San", value: "Nf3" },
    { type: "Nag", value: "$2" },
    { type: "Outcome", value: "0-1" },
];

for (const colorScheme of ["light", "dark"] as const) {
    for (const tableView of [true, false]) {
        test(`game-end: appended analysis follows the inline result and reads apart at full contrast in ${tableView ? "table" : "inline"} view, ${colorScheme}`, async ({
            page,
            mockScenario,
        }) => {
            await mockScenario({
                commands: filesWorkspaceCommands([[filesWorkspaceFixture.pgnFile]], {
                    ...pgnFileCommands,
                    write_game: { result: { stamp: "e".repeat(64), revision: "e2e-pgn-revision" } },
                    lex_pgn: { pgnTokens: { [filesWorkspaceFixture.pgnGame]: analysisTokens } },
                }),
            });
            await page.emulateMedia({ colorScheme });
            await page.addInitScript(
                ({ colorScheme, tableView }) => {
                    localStorage.setItem("mantine-color-scheme", colorScheme);
                    localStorage.setItem("letters", JSON.stringify("letters"));
                    localStorage.setItem("table-view", JSON.stringify(tableView));
                },
                { colorScheme, tableView },
            );
            await page.goto("/library");
            await page.getByRole("button", { name: "Choose folder", exact: true }).click();
            await selectFilesTreeRow(page, filesWorkspaceFixture.pgnFile.name);
            await page.getByRole("button", { name: "Open game", exact: true }).click();
            await expect(page).toHaveURL("/");
            const notation = page.locator("#bottomRight");
            const end = notation.getByRole("button", { name: "e5", exact: true });
            const annotated = notation.getByRole("button", { name: "Nf3?", exact: true });
            await annotated.click();
            await playBoardMove(page, page.locator("cg-board").first(), "b8", "c6");
            const analysis = notation.getByRole("button", { name: "Nc6", exact: true });
            await expect(analysis).toBeVisible();
            await page.getByRole("button", { name: "Go to start", exact: true }).click();
            await page.mouse.move(0, 0);
            await waitForFontsSettled(page);
            await expect(notation.locator('[data-notation-current="true"]')).toHaveCount(0);
            expect(await end.evaluate((element) => element.matches(":hover"))).toBe(false);
            expect(await analysis.evaluate((element) => element.matches(":hover"))).toBe(false);
            expect(await annotated.evaluate((element) => element.matches(":hover"))).toBe(false);
            expect(await analysis.evaluate((element) => !!element.closest("td"))).toBe(tableView);
            const boundary = notation.locator("[data-notation-game-end]");
            await expect(boundary).toContainText("0-1 · Black wins · Abandoned");
            await expect(boundary).toContainText("Analysis after the game");
            await expect(analysis).toHaveAttribute("data-notation-analysis", "true");
            await expect(annotated).toHaveAttribute("data-notation-analysis", "true");
            await expect(end).not.toHaveAttribute("data-notation-analysis");
            const endBox = (await end.boundingBox())!;
            const boundaryBox = (await boundary.boundingBox())!;
            const analysisBox = (await analysis.boundingBox())!;
            expect(endBox.y + endBox.height).toBeLessThanOrEqual(boundaryBox.y + 1);
            expect(boundaryBox.y + boundaryBox.height).toBeLessThanOrEqual(analysisBox.y + 1);
            // Analysis moves stay on the main line (on the card), outside any .variationBlock whose
            // own dimmed colour would mask the analysis cue.
            for (const move of [annotated, analysis]) {
                const inVariationBlock = await move.evaluate((element) => {
                    for (let node: Element | null = element; node; node = node.parentElement) {
                        if ([...node.classList].some((cls) => cls.includes("variationBlock"))) {
                            return true;
                        }
                    }
                    return false;
                });
                expect(inVariationBlock).toBe(false);
            }
            const dimmed = await page.evaluate(() => {
                const probe = document.createElement("span");
                probe.style.color = "var(--mantine-color-dimmed)";
                document.body.append(probe);
                const color = getComputedStyle(probe).color;
                probe.remove();
                return color;
            });
            const styleOf = (move: typeof end) =>
                move.evaluate((element) => {
                    const opacities: string[] = [];
                    for (let node: Element | null = element; node; node = node.parentElement) {
                        opacities.push(getComputedStyle(node).opacity);
                    }
                    return { opacities, fontStyle: getComputedStyle(element).fontStyle };
                });
            const played = { ...(await styleOf(end)), ...(await paintedText(end)) };
            const annotatedStyle = {
                ...(await styleOf(annotated)),
                ...(await paintedText(annotated)),
            };
            const unannotatedStyle = {
                ...(await styleOf(analysis)),
                ...(await paintedText(analysis)),
            };
            for (const [name, style] of [
                ["played", played],
                ["annotated analysis", annotatedStyle],
                ["unannotated analysis", unannotatedStyle],
            ] as const) {
                // contrastRatio ignores opacity, so the whole opacity chain is read separately.
                expect(style.opacities, `${name} opacity chain`).toEqual(
                    style.opacities.map(() => "1"),
                );
                expect(
                    contrastRatio(style.color, style.layers),
                    `${name} text contrast`,
                ).toBeGreaterThanOrEqual(4.5);
            }
            expect(played.fontStyle).toBe("normal");
            expect(annotatedStyle.fontStyle).toBe("italic");
            expect(unannotatedStyle.fontStyle).toBe("italic");
            expect(unannotatedStyle.color).toBe(dimmed);
            expect(unannotatedStyle.color).not.toBe(played.color);
            expect(annotatedStyle.color).not.toBe(dimmed);
            await expect(
                page.getByText("Unexpected Tauri IPC command", { exact: false }),
            ).toHaveCount(0);
        });
    }
}

const TERMINATION_SUGGESTIONS = [
    ["Normal", "Checkmate, resignation or agreed draw"],
    ["Time forfeit", "A player ran out of time"],
    ["Abandoned", "The game was broken off"],
    ["Adjudication", "Decided by an arbiter"],
    ["Rules infraction", "Lost for breaking a rule"],
    ["Unterminated", "The game is not finished"],
];

for (const colorScheme of ["light", "dark"] as const) {
    test(`game-end: the Termination field suggests the PGN-standard values with hints, ${colorScheme}`, async ({
        page,
        mockScenario,
    }) => {
        await mockScenario({
            commands: filesWorkspaceCommands([[filesWorkspaceFixture.pgnFile]], {
                ...pgnFileCommands,
                lex_pgn: { pgnTokens: { [filesWorkspaceFixture.pgnGame]: tokens } },
            }),
        });
        await page.emulateMedia({ colorScheme });
        await page.addInitScript((colorScheme) => {
            localStorage.setItem("mantine-color-scheme", colorScheme);
        }, colorScheme);
        await page.goto("/library");
        await page.getByRole("button", { name: "Choose folder", exact: true }).click();
        await selectFilesTreeRow(page, filesWorkspaceFixture.pgnFile.name);
        await page.getByRole("button", { name: "Open game", exact: true }).click();
        await expect(page).toHaveURL("/");
        await page.getByRole("tab", { name: "Info", exact: true }).click();
        const field = page.getByRole("textbox", { name: "Termination", exact: true });
        await expect(field).toHaveValue("Abandoned");
        await field.focus();
        const listbox = page.locator(`#${await field.getAttribute("aria-controls")}`);
        const options = listbox.getByRole("option");
        await expect(options).toHaveCount(TERMINATION_SUGGESTIONS.length);
        for (const [index, [value, hint]] of TERMINATION_SUGGESTIONS.entries()) {
            await expect(options.nth(index)).toHaveText(`${value}${hint}`);
        }
        await page.mouse.move(0, 0);
        await waitForFontsSettled(page);
        // The list is portaled, so the snapshot spans the field and the list together.
        const fieldBox = (await field.boundingBox())!;
        const listboxBox = (await listbox.boundingBox())!;
        const x = Math.min(fieldBox.x, listboxBox.x) - 8;
        const y = fieldBox.y - 8;
        await expect(page).toHaveScreenshot(`termination-suggestions-${colorScheme}.png`, {
            clip: {
                x,
                y,
                width:
                    Math.max(fieldBox.x + fieldBox.width, listboxBox.x + listboxBox.width) - x + 8,
                height: listboxBox.y + listboxBox.height - y + 8,
            },
        });
        await listbox.getByRole("option", { name: /^Time forfeit/ }).click();
        await expect(field).toHaveValue("Time forfeit");
        await expect(page.getByText("Unexpected Tauri IPC command", { exact: false })).toHaveCount(
            0,
        );
    });
}
