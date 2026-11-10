import AxeBuilder from "@axe-core/playwright";
import type { KeyedNode } from "@lichess-org/chessground/types";
import { expect, test as base, type Locator, type Page, type Request } from "@playwright/test";
import type {
    BestMovesPayload,
    DatabaseInfo,
    ErrorPayload,
    NormalizedGame,
    StampedGame,
    EngineCompletion,
    EngineInstallRequest,
    InstalledEngineResult,
} from "../src/bindings/generated";
import { needsTwoPaneStack } from "../src/state/paneLayout";
import { deserializeStorageValue } from "../src/state/store/debouncedStorage";
import type { Tab } from "../src/state/workspaceTypes";

type MockCommand = {
    /** Builds and retains an engine workflow result from its real submitted intent. */
    engineInstall?: boolean;
    /** Game replies echo the submitted exact identity through the real transport facade. */
    gameState?: Record<string, unknown>;
    /** Multi-game fixtures retain the requested native index and PGN identity. */
    pgnGames?: StampedGame[];
    pgnTokens?: Record<string, unknown[]>;
    /** Current database rows retain orientation writes and the returned CAS stamp. */
    databaseGames?: NormalizedGame[];
    delay?: number;
    error?: string | ErrorPayload;
    result?: unknown;
    /** Sequential command results model polling and post-mutation refreshes. */
    results?: unknown[];
    /** Sequential command outcomes model successful calls followed by failures. */
    outcomes?: ({ result: unknown } | { error: string | ErrorPayload })[];
    /**
     * Last-games query reply for `get_games` (`player1`, `sides: "Any"`, date desc,
     * pageSize 10). The Games table keeps `result`.
     */
    lastGames?: unknown;
};

export type MockScenario = {
    commands?: Record<string, MockCommand>;
};

type MockEngineSearchState = {
    pending: unknown[];
    settled: { generation: unknown; outcome: "cancelled" | "failed"; error: ErrorPayload }[];
    stops: { engine: unknown; tab: unknown; expectedGeneration: unknown; result: unknown }[];
};

export type AnalysisRequest = {
    id: string;
    tab: string;
    generation: string;
    options: { fen: string; moves: string[] };
};

// Native IPC serializes these bigint counters as JSON numbers.
export type BestMovesFixturePayload = Omit<BestMovesPayload, "bestLines"> & {
    bestLines: (Omit<BestMovesPayload["bestLines"][number], "nodes" | "nps"> & {
        nodes: number;
        nps: number;
    })[];
};

export function bestMovesPayload(
    request: AnalysisRequest,
    sanMoves: string[],
    uciMoves: string[],
    score: number,
): BestMovesFixturePayload {
    return {
        engine: request.id,
        tab: request.tab,
        generation: request.generation,
        fen: request.options.fen,
        moves: request.options.moves,
        progress: 50,
        bestLines: [
            {
                depth: 20,
                multipv: 1,
                nodes: 1234,
                nps: 5678,
                score: { value: { type: "cp", value: score }, wdl: null },
                sanMoves,
                uciMoves,
            },
        ],
    };
}

export async function seedAnalysisEngines(
    page: Page,
    engines: {
        id: string;
        name: string;
        handleId: string;
        settings?: { type: "string"; name: string; value: string }[];
    }[],
) {
    await page.addInitScript((engines) => {
        localStorage.setItem("erase-drawables-on-click", "false");
        localStorage.setItem(
            "engines",
            JSON.stringify(
                engines.map(({ id, name, handleId, settings }) => ({
                    type: "local",
                    id,
                    name,
                    version: "19",
                    filename: "stockfish",
                    handle: { id: { id: handleId }, kind: "engine" },
                    loaded: true,
                    settings: settings ?? [],
                    go: { t: "Infinite" },
                })),
            ),
        );
    }, engines);
}

export const filesWorkspaceFixture = {
    workspace: { id: { id: "files-workspace" }, kind: "fileWorkspace" },
    openingDirectory: {
        handle: { id: { id: "opening-directory" }, kind: "fileWorkspace" },
        kind: "directory",
        name: "Openings",
        children: [],
        metadata: null,
        gameCount: null,
        lastModified: 0,
    },
    pgnFile: {
        handle: { id: { id: "najdorf-file" }, kind: "fileWorkspace" },
        kind: "file",
        name: "Najdorf",
        children: [],
        metadata: { type: "game", tags: [] },
        gameCount: 1,
        lastModified: 0,
    },
    pgnGame: '[Event "E2E"]\n[White "Weiss"]\n[Black "Schwarz"]\n[Result "*"]\n\n1. e4 c5 *',
} as const;

const pgnGameStamp = "e".repeat(64);
const pgnGameRevision = "e2e-pgn-revision";
const stampedPgnGame = {
    pgn: filesWorkspaceFixture.pgnGame,
    stamp: pgnGameStamp,
    revision: pgnGameRevision,
    present: true,
};

/**
 * The browser failure a failed request contributes to the page fixture, or `null` when it is not
 * one. An image fetch the page itself abandoned is not a broken request: a board that first renders
 * the default texture and then hydrates a stored "off" can abandon the in-flight tile
 * (f-20261102-06). Only that abort is exempt. Refused, reset and blocked requests, and aborts of
 * any other resource type, stay failures.
 */
export function localRequestFailure(request: Request, allowedOrigin: string): string | null {
    if (new URL(request.url()).origin !== allowedOrigin) return null;
    if (request.resourceType() === "image" && request.failure()?.errorText === "net::ERR_ABORTED") {
        return null;
    }
    return `Failed local request: ${request.url()}`;
}

export async function expectNotificationSettled(notification: Locator) {
    await expect(notification).toHaveCSS("opacity", "1");
    // Opacity completes before Mantine's cubic transform stops overshooting its container.
    await expect(notification).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
}

/** Skip cancelled or retargeted transitions and await their replacements before geometry or colour reads.
 * Ignore infinite animations. */
export async function waitForTransitionsSettled(page: Page) {
    await page.evaluate(async () => {
        while (true) {
            const animations = document.getAnimations().filter((animation) => {
                const endTime = animation.effect?.getComputedTiming().endTime;
                return (
                    typeof endTime === "number" &&
                    Number.isFinite(endTime) &&
                    animation.playState !== "finished"
                );
            });
            if (animations.length === 0) return;
            await Promise.allSettled(animations.map((animation) => animation.finished));
        }
    });
}

export async function splitTextWords(labels: Locator): Promise<string[]> {
    return labels.evaluateAll((elements) =>
        elements.flatMap((element) => {
            if (!element.getBoundingClientRect().width) return [];
            const words: string[] = [];
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
                const node = walker.currentNode;
                for (const match of (node.textContent ?? "").matchAll(/\S+/g)) {
                    const range = document.createRange();
                    range.setStart(node, match.index);
                    range.setEnd(node, match.index + match[0].length);
                    if (range.getClientRects().length > 1) words.push(match[0]);
                }
            }
            return words;
        }),
    );
}

export async function waitForScrollAreaScrollbarsHidden(page: Page) {
    await expect(page.locator('.mantine-ScrollArea-scrollbar[data-state="visible"]')).toHaveCount(
        0,
    );
}

export async function wheelBoardStackTo(page: Page, target: Locator) {
    // The board tab can mount after the caller's last wait; act only on its settled layout.
    await expect
        .poll(
            async () => {
                const layout = page.locator("[data-board-layout]");
                if ((await layout.count()) !== 1) return false;
                const snapshot = await layout.evaluate((element) => ({
                    width: element.getBoundingClientRect().width,
                    rootFont: parseFloat(getComputedStyle(document.documentElement).fontSize),
                    attribute: element.getAttribute("data-board-layout"),
                }));
                return (
                    snapshot.attribute ===
                    (needsTwoPaneStack(snapshot.width, snapshot.rootFont) ? "stacked" : "mosaic")
                );
            },
            { message: "board layout reflects its current width and root font" },
        )
        .toBe(true);
    const stack = page.locator('[data-board-layout="stacked"] > div').first();
    if ((await stack.count()) === 0) return;
    // Stay within wheelColumnTo's enclosing 15-second toPass when it calls this helper.
    await expect(async () => {
        const frame = (await stack.boundingBox())!;
        const box = (await target.boundingBox())!;
        const { top, maximum } = await stack.evaluate((element) => ({
            top: element.scrollTop,
            maximum: element.scrollHeight - element.clientHeight,
        }));
        const delta = box.y - frame.y - 8;
        const expected = Math.max(0, Math.min(maximum, top + delta));
        if (Math.abs(top - expected) <= 1) return;
        // The four-pixel tile margin belongs to the outer stack, not an inner scroller.
        await page.mouse.move(frame.x + 1, frame.y + Math.min(frame.height / 2, 100));
        await page.mouse.wheel(0, delta);
        await expect
            .poll(
                () =>
                    stack.evaluate(
                        (element, expected) => Math.abs(element.scrollTop - expected),
                        expected,
                    ),
                { timeout: 1000 },
            )
            .toBeLessThanOrEqual(1);
    }).toPass({ timeout: 10_000, intervals: [100, 250, 500] });
    const frame = (await stack.boundingBox())!;
    await expect
        .poll(
            async () => {
                const current = (await target.boundingBox())!;
                return (
                    current.y < frame.y + frame.height - 20 && current.y + current.height > frame.y
                );
            },
            { message: "user wheel reveals the stacked tile" },
        )
        .toBe(true);
}

export async function wheelColumnTo(page: Page, column: Locator, target: Locator) {
    const targetCentreIsHitTestable = () =>
        target.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const hit = document.elementFromPoint(
                box.left + box.width / 2,
                box.top + box.height / 2,
            );
            return hit !== null && element.contains(hit);
        });

    await expect(async () => {
        if (await targetCentreIsHitTestable()) {
            return;
        }

        const measure = async () => {
            const columnBox = (await column.boundingBox())!;
            const targetBox = (await target.boundingBox())!;
            const stack = page.locator('[data-board-layout="stacked"]');
            const stackBox = (await stack.count())
                ? (await stack.boundingBox())!
                : { y: 0, height: page.viewportSize()!.height };
            const top = Math.max(columnBox.y, stackBox.y, 0);
            const bottom = Math.min(
                columnBox.y + columnBox.height,
                stackBox.y + stackBox.height,
                page.viewportSize()!.height,
            );
            return { columnBox, targetBox, top, bottom };
        };
        let { columnBox, targetBox, top, bottom } = await measure();
        if (bottom - top < Math.max(targetBox.height, 40)) {
            await wheelBoardStackTo(page, column);
            ({ columnBox, targetBox, top, bottom } = await measure());
        }
        await expect(bottom - top).toBeGreaterThanOrEqual(Math.max(targetBox.height, 40));
        const centre = (top + bottom) / 2;
        // The column's left border is outside its nested notation viewport.
        await page.mouse.move(columnBox.x, centre);
        await page.mouse.wheel(0, targetBox.y + targetBox.height / 2 - centre);
        await expect
            .poll(targetCentreIsHitTestable, {
                timeout: 1000,
                message: "target centre is hit-testable after user wheel scrolling",
            })
            .toBe(true);
    }).toPass({ timeout: 15_000, intervals: [100, 250, 500] });
}

type Rgb = [number, number, number];

/** Parses a computed CSS colour (`rgb()`, `rgba()` or `color(srgb …)`) into 0-255 channels and alpha. */
export function parseCssColor(color: string): [number, number, number, number] {
    const rgb = color.match(
        /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/,
    );
    if (rgb) return [+rgb[1], +rgb[2], +rgb[3], rgb[4] === undefined ? 1 : +rgb[4]];
    const srgb = color.match(
        /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/,
    );
    if (srgb) {
        const alpha = srgb[4] === undefined ? 1 : +srgb[4];
        return [+srgb[1] * 255, +srgb[2] * 255, +srgb[3] * 255, alpha];
    }
    throw new Error(`unparsed color ${color}`);
}

function paintOver(color: string, below: Rgb): Rgb {
    const [r, g, b, a] = parseCssColor(color);
    return [r * a + below[0] * (1 - a), g * a + below[1] * (1 - a), b * a + below[2] * (1 - a)];
}

function relativeLuminance([r, g, b]: Rgb): number {
    const channel = (value: number) => {
        const scaled = value / 255;
        return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * WCAG contrast of `foreground` text against `backgroundLayers`, painted bottom-to-top over white.
 * Pass every translucent ancestor background, or one opaque background.
 */
export function contrastRatio(foreground: string, backgroundLayers: readonly string[]): number {
    const background = backgroundLayers.reduce<Rgb>(
        (below, layer) => paintOver(layer, below),
        [255, 255, 255],
    );
    const [lighter, darker] = [
        relativeLuminance(paintOver(foreground, background)),
        relativeLuminance(background),
    ].sort((a, b) => b - a);
    return (lighter + 0.05) / (darker + 0.05);
}

export async function waitForFontsSettled(page: Page) {
    // One frame lets faces needed by just-rendered text enter loading before the first read, otherwise an empty set already reads as "loaded".
    await page.evaluate(
        () =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => resolve());
            }),
    );

    let last: { state: string; family?: string; unicodeRange?: string } = { state: "loading" };
    await expect
        .poll(
            async () => {
                const snapshot = await page.evaluate(() => {
                    // local(Arial) metric faces in src/styles/fonts.css that stay "error" where Arial is absent.
                    const isMetricFallback = (family: string) => family.endsWith(" Fallback");
                    const faces = [...document.fonts];
                    const failed = faces.find(
                        (face) => face.status === "error" && !isMetricFallback(face.family),
                    );
                    if (failed) {
                        return {
                            state: "error" as const,
                            family: failed.family,
                            unicodeRange: failed.unicodeRange,
                        };
                    }
                    if (
                        faces.some((face) => face.status === "loading") ||
                        document.fonts.status !== "loaded"
                    ) {
                        return { state: "loading" as const };
                    }
                    return { state: "settled" as const };
                });
                last = snapshot;
                return snapshot.state;
            },
            { message: "web fonts settle or one fails" },
        )
        .not.toBe("loading");

    if (last.state === "error") {
        throw new Error(`Font face failed to load: ${last.family} (${last.unicodeRange})`);
    }
}

export async function dragMosaicDivider(
    page: Page,
    {
        root,
        split,
        percentage,
        direction,
        release = true,
        crossAxisRatio = 0.5,
    }: {
        root: Locator;
        split: Locator;
        percentage: number;
        direction: "row" | "column";
        release?: boolean;
        crossAxisRatio?: number;
    },
) {
    const box = (await root.boundingBox())!;
    const divider = (await split.boundingBox())!;
    const x =
        direction === "row"
            ? box.x + (box.width * percentage) / 100
            : divider.x + divider.width * crossAxisRatio;
    const y =
        direction === "column"
            ? box.y + (box.height * percentage) / 100
            : divider.y + divider.height * crossAxisRatio;
    await page.mouse.move(
        direction === "row" ? divider.x + divider.width / 2 : x,
        direction === "column" ? divider.y + divider.height / 2 : y,
    );
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 5 });
    if (release) await page.mouse.up();
}

// The document-width assertion cannot see content that a container absorbs or cuts away, nor
// anything pushed off the left edge — overflow to the left never adds to `scrollWidth` — so a page
// that clipped its content would pass it. This walks every box instead.
//
// `mode: "clipped"` (the default) is horizontal only and counts every box narrower than its
// content, scroll containers included: the Files columns must fit without their own scroll
// container absorbing content. `mode: "reachable"` is the whole-page rule of
// `d-20260831-16`, on both axes, where only lost content of a visible box counts:
// * a box that clips (`overflow: hidden|clip`) while a descendant box or text passes its edge;
// * a spill onto the page itself: sideways past the viewport, or downwards out of a fixed box, which
//   does not move while the page scrolls. A spill into a container is judged there — a scrolling
//   container keeps it reachable, a clipping one reports itself;
// * a fixed or positioned box past the viewport where nothing scrolls to it.
// Both modes count a box that starts before the content of the container holding it, or before the
// document's origin, because scrolling only ever reaches right and down.
export async function assertNothingClipped(
    target: Locator,
    { mode = "clipped" }: { mode?: "clipped" | "reachable" } = {},
) {
    const offenders = await target.evaluate((element, reachableMode) => {
        const axes = [
            {
                name: "x",
                scroll: "scrollWidth",
                client: "clientWidth",
                overflow: "overflowX",
                start: "left",
                end: "right",
                clientStart: "clientLeft",
                scrolled: "scrollLeft",
                page: "scrollX",
                viewport: "innerWidth",
            },
            {
                name: "y",
                scroll: "scrollHeight",
                client: "clientHeight",
                overflow: "overflowY",
                start: "top",
                end: "bottom",
                clientStart: "clientTop",
                scrolled: "scrollTop",
                page: "scrollY",
                viewport: "innerHeight",
            },
        ] as const;
        type Axis = (typeof axes)[number];
        const overflowOf = (node: Element, axis: Axis) => getComputedStyle(node)[axis.overflow];
        const scrolls = (overflow: string) => overflow === "auto" || overflow === "scroll";
        // Where a node's overflow ends up: its nearest ancestor that does not let it spill further,
        // or null for the page itself.
        const container = (node: Element, axis: Axis) => {
            for (let parent = node.parentElement; parent; parent = parent.parentElement) {
                if (parent === document.body || parent === document.documentElement) return null;
                if (overflowOf(parent, axis) !== "visible") return parent;
            }
            return null;
        };
        // A box nobody can see has no visible content to lose: Mantine keeps a finished Button
        // loader mounted at opacity 0, parked above the button, for its exit transition.
        const invisible = (node: Element) => {
            if (getComputedStyle(node).visibility === "hidden") return true;
            // Screen-reader-only labels intentionally have a zero-area visual clip.
            if (getComputedStyle(node).clip === "rect(0px, 0px, 0px, 0px)") return true;
            for (let box: Element | null = node; box; box = box.parentElement) {
                if (getComputedStyle(box).opacity === "0") return true;
            }
            return false;
        };
        const insideFixed = (node: Element) => {
            for (let box: Element | null = node; box; box = box.parentElement) {
                if (getComputedStyle(box).position === "fixed") return true;
            }
            return false;
        };
        // A box larger than its content on this axis, other than a deliberate, visible truncation:
        // an ellipsis (a game name in the list) truncates inline text, never a vertical cut.
        const overflowing = (node: Element, axis: Axis) =>
            node[axis.scroll] > node[axis.client] + 1 &&
            !(axis.name === "x" && getComputedStyle(node).textOverflow === "ellipsis");
        // `scrollWidth` also counts empty margin and padding (a Mantine Switch track label's 50px
        // margin), so a reported overflow only counts when visible text or a leaf box (an icon, the
        // switch thumb) really passes the edge. An input's value is not in the DOM, so its scroll size is all there is.
        // A text range's rect is the font's content area, which can overhang a tight line box by a
        // pixel or two (a Mantine Button label at 200%) without cutting a glyph; on y the extent is
        // the line boxes, so that half-leading overhang is taken off both ends.
        const textExtent = (text: Text, axis: Axis) => {
            const range = document.createRange();
            range.selectNode(text);
            const box = range.getBoundingClientRect();
            if (box.width === 0 || box.height === 0) return null;
            if (axis.name === "x") return { start: box.left, end: box.right };
            const lineHeight = parseFloat(getComputedStyle(text.parentElement!).lineHeight);
            const line = range.getClientRects()[0];
            const overhang =
                Number.isFinite(lineHeight) && line
                    ? Math.max(0, (line.height - lineHeight) / 2)
                    : 0;
            return { start: box.top + overhang, end: box.bottom - overhang };
        };
        const contentPasses = (node: Element, axis: Axis, edge: number): boolean => {
            if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)
                return true;
            for (const child of node.childNodes) {
                if (child instanceof Text) {
                    const extent = textExtent(child, axis);
                    if (extent && extent.end > edge + 1) return true;
                    continue;
                }
                if (!(child instanceof Element) || invisible(child)) continue;
                // What paints is text and leaf boxes; a parent's padding is not content. A nested
                // container that does not let overflow spill is judged on its own, so only its own
                // box counts here, never what it scrolls or cuts.
                const nested = overflowOf(child, axis) !== "visible";
                if (child.childNodes.length > 0 && !nested) {
                    if (contentPasses(child, axis, edge)) return true;
                    continue;
                }
                const box = child.getBoundingClientRect();
                if (box.width > 0 && box.height > 0 && box[axis.end] > edge + 1) return true;
            }
            return false;
        };
        const contentLost = (node: Element, axis: Axis) => {
            if (!reachableMode) return axis.name === "x";
            // Native caret navigation owns a visible text input's private value scroll even when
            // computed overflow clips it. The actual engine Name End/Home journeys prove access.
            if (
                axis.name === "x" &&
                node instanceof HTMLInputElement &&
                node.type === "text" &&
                node.value !== "" &&
                node.clientWidth > 0
            )
                return false;
            const overflow = overflowOf(node, axis);
            // Scrolling reaches what a scroller holds only if it has room to show some of it: one
            // squeezed to nothing (a stacked panel's list) hides its content entirely.
            if (scrolls(overflow)) return node[axis.client] < 1;
            const ownEdge =
                node.getBoundingClientRect()[axis.start] +
                node[axis.clientStart] +
                node[axis.client];
            if (overflow !== "visible") return contentPasses(node, axis, ownEdge);
            // A visible spill into a container is judged by that container.
            if (container(node, axis)) return false;
            // Onto the page: sideways it is lost only past the viewport, since the page never scrolls
            // sideways; downwards it is lost out of a fixed box, which does not move while the page
            // scrolls and whose spill other fixed chrome paints over (the navbar over the title bar).
            if (axis.name === "x") return contentPasses(node, axis, window.innerWidth);
            return insideFixed(node) && contentPasses(node, axis, ownEdge);
        };
        // Where content held by `bound` starts, in viewport coordinates: scrolling reaches only right
        // and down from there. The page's origin is the document's, except inside a fixed box.
        const contentOrigin = (bound: Element | null, fixed: boolean, axis: Axis) =>
            bound
                ? bound.getBoundingClientRect()[axis.start] +
                  bound[axis.clientStart] -
                  bound[axis.scrolled]
                : fixed
                  ? 0
                  : -window[axis.page];
        const boxLost = (node: Element, box: DOMRect, axis: Axis) => {
            const bound = container(node, axis);
            const fixed = insideFixed(node);
            const origin = contentOrigin(bound, fixed, axis);
            if (box[axis.start] < origin - 1)
                return `starts at ${Math.round(box[axis.start])}, before ${Math.round(origin)}`;
            // Past the far edge: a container's own scroll size covers what it holds; the page scrolls
            // down but never sideways, and a fixed box never moves.
            if (!reachableMode || bound || (axis.name === "y" && !fixed)) return null;
            return box[axis.end] > window[axis.viewport] + 1
                ? `ends at ${Math.round(box[axis.end])}, past the viewport`
                : null;
        };
        // Text can start before its holder even when its element does not (a negative text-indent):
        // the holder is the element itself if it clips or scrolls, else its container.
        const textBeforeOrigin = (node: Element, axis: Axis) => {
            const holder = overflowOf(node, axis) !== "visible" ? node : container(node, axis);
            const origin = contentOrigin(holder, insideFixed(node), axis);
            for (const child of node.childNodes) {
                if (!(child instanceof Text)) continue;
                const extent = textExtent(child, axis);
                if (extent && extent.start < origin - 1)
                    return `text starts at ${Math.round(extent.start)}, before ${Math.round(origin)}`;
            }
            return null;
        };
        const describe = (node: Element, why: string) =>
            `${node.tagName.toLowerCase()}.${String(node.className)}: ${why}`;
        const found: string[] = [];
        const check = (node: Element, placed: boolean) => {
            if (reachableMode && invisible(node)) return;
            const box = node.getBoundingClientRect();
            const laidOut = box.width > 1 && box.height > 1;
            // The Files columns keep their horizontal-only check; the page-wide rule adds y.
            for (const axis of reachableMode ? axes : axes.slice(0, 1)) {
                // No layout-box guard: an element without one (an svg child, an inline span)
                // reports 0 for both sizes, while a scroller squeezed to zero width must count.
                if (overflowing(node, axis) && contentLost(node, axis)) {
                    const size = `${node[axis.scroll]}px > ${node[axis.client]}px`;
                    found.push(describe(node, `${axis.name} ${size}`));
                }
                const lost = placed && laidOut ? boxLost(node, box, axis) : null;
                if (lost) found.push(describe(node, `${axis.name} ${lost}`));
                if (placed) {
                    const text = textBeforeOrigin(node, axis);
                    if (text) found.push(describe(node, `${axis.name} ${text}`));
                }
            }
        };
        for (let node = element.parentElement; node; node = node.parentElement) check(node, false);
        for (const node of [element, ...element.querySelectorAll("*")]) check(node, true);
        return found;
    }, mode === "reachable");
    expect(offenders, `content clipped: ${offenders.join("; ")}`).toEqual([]);
}

// The whole rendered page under the reachable rule — the 320px / 200% layout contract
// (d-20260831-16), beside the document-width check that it does not replace.
export async function assertPageNotClipped(page: Page) {
    await assertNothingClipped(page.locator("body"), { mode: "reachable" });
}

// Both Files columns with everything in them: the controls and tree, the action row and the card.
export async function assertFilesColumnsNotClipped(page: Page) {
    for (const column of await page.locator(".mantine-SimpleGrid-root > *").all()) {
        await assertNothingClipped(column);
    }
}

/** Reloads once without the fixture's per-load storage reset, as a real reload would. */
export async function preserveStorageForReload(page: Page) {
    await page.evaluate(() => sessionStorage.setItem("__E2E_PRESERVE_STORAGE_ONCE__", "1"));
    await page.reload();
}

export async function activeWorkspaceTab(page: Page) {
    const stored = await page.evaluate(() => sessionStorage.getItem("workspace"));
    const workspace = stored && deserializeStorageValue<{ tabs: Tab[]; activeTab: string }>(stored);
    expect(workspace).toBeTruthy();
    return workspace ? workspace.tabs.find((tab) => tab.value === workspace.activeTab)! : undefined;
}

export function whitePawnSquares(board: Locator) {
    return board
        .locator("piece.white.pawn")
        .evaluateAll((pawns) => pawns.map((pawn) => (pawn as KeyedNode).cgKey).sort());
}

export async function assertChooserInsideBoard(board: Locator, chooser: Locator) {
    const boardBox = (await board.boundingBox())!;
    const card = chooser.locator("..");
    const cardBox = (await card.boundingBox())!;
    expect(cardBox.x).toBeGreaterThanOrEqual(boardBox.x);
    expect(cardBox.y).toBeGreaterThanOrEqual(boardBox.y);
    expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(boardBox.x + boardBox.width + 1);
    expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(boardBox.y + boardBox.height + 1);
    expect(cardBox.y - boardBox.y).toBeLessThanOrEqual(8);
    // The frame is centred exactly; Chessground rounds the board size down to a multiple of eight
    // device pixels, so its centre can differ by up to 4 px.
    expect(
        Math.abs(cardBox.x + cardBox.width / 2 - boardBox.x - boardBox.width / 2),
    ).toBeLessThanOrEqual(4);
}

// A trial click waits for visible, stable geometry, but a board that remounts right after a
// navigation can still report no box on the next call; poll until one is measured
// (f-20261030-21).
async function boardBox(board: Locator) {
    let box: Awaited<ReturnType<Locator["boundingBox"]>> = null;
    await expect
        .poll(async () => {
            await board.click({ trial: true });
            box = await board.boundingBox();
            return box;
        })
        .not.toBeNull();
    return box!;
}

function squarePosition(square: string, box: { width: number; height: number }) {
    const file = square.charCodeAt(0) - "a".charCodeAt(0);
    const rank = Number(square[1]) - 1;
    return {
        x: ((file + 0.5) * box.width) / 8,
        y: ((7 - rank + 0.5) * box.height) / 8,
    };
}

export async function dragBoard(
    page: Page,
    board: Locator,
    from: string,
    to: string,
    button: "left" | "right",
) {
    const box = await boardBox(board);
    const start = squarePosition(from, box);
    const end = squarePosition(to, box);
    await page.mouse.move(box.x + start.x, box.y + start.y);
    await page.mouse.down({ button });
    await page.mouse.move(box.x + end.x, box.y + end.y, { steps: 4 });
    // Chessground resolves gesture endpoints on its animation frame.
    await board.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await page.mouse.up({ button });
    await page.mouse.move(0, 0);
}

export async function drawMark(page: Page, board: Locator, from: string, to = from) {
    await dragBoard(page, board, from, to, "right");
}

export async function playBoardMove(page: Page, board: Locator, from: string, to: string) {
    const interactiveBoard = board.and(page.locator(".cg-wrap.manipulable cg-board"));
    for (const square of [from, to]) {
        await expect
            .poll(() => interactiveBoard.count(), {
                message: "The board stayed view-only instead of becoming interactive",
            })
            .toBe(1);
        const box = await boardBox(interactiveBoard);
        await interactiveBoard.click({
            position: squarePosition(square, box),
        });
    }
}

// Selects a Files tree row by its name. Once a row wraps at a narrow width its centre can be one of
// its icon buttons, so a plain row click would not select; the name always does.
export async function selectFilesTreeRow(page: Page, name: string): Promise<Locator> {
    const row = page.getByRole("treeitem", { name, exact: true });
    await row.getByText(name, { exact: true }).click();
    await expect(row).toHaveAttribute("aria-selected", "true");
    return row;
}

/** Native answers for selecting `pgnFile`: the card and its game list read and lex the one game. */
export const pgnFileCommands: NonNullable<MockScenario["commands"]> = {
    read_games: { result: [stampedPgnGame] },
    read_game: { result: stampedPgnGame },
    file_revision: { result: pgnGameRevision },
    lex_pgn: {
        result: [
            { type: "Header", value: { tag: "Event", value: "E2E" } },
            { type: "Header", value: { tag: "White", value: "Weiss" } },
            { type: "Header", value: { tag: "Black", value: "Schwarz" } },
            { type: "Header", value: { tag: "Result", value: "*" } },
            { type: "San", value: "e4" },
            { type: "San", value: "c5" },
            { type: "Outcome", value: "*" },
        ],
    },
};

export const gameOpeningFixture = {
    databaseId: "game-opening-db",
    databaseTitle: "Opening fixture database",
    file: { ...filesWorkspaceFixture.pgnFile, name: "Two distinct games", gameCount: 2 },
    games: [
        {
            id: 101,
            stamp: "a".repeat(64),
            fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            white: "First White",
            white_id: 1,
            black: "First Black",
            black_id: 2,
            event: "First event",
            event_id: 1,
            site: "?",
            site_id: 1,
            date: "2026.10.01",
            round: "1",
            result: "*",
            white_elo: 1500,
            black_elo: 1400,
            ply_count: 2,
            moves: "1. e4 e5 *",
        },
        {
            id: 202,
            stamp: "b".repeat(64),
            fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            white: "Second White",
            white_id: 3,
            black: "Second Black",
            black_id: 4,
            event: "Second event",
            event_id: 2,
            site: "?",
            site_id: 1,
            date: "2026.10.02",
            round: "2",
            result: "*",
            white_elo: 1600,
            black_elo: 1550,
            ply_count: 2,
            moves: "1. d4 d5 *",
        },
    ] satisfies NormalizedGame[],
};
const openingPgnGames = gameOpeningFixture.games.map((game, index) => ({
    pgn: `[Event "${game.event}"]\n[White "${game.white}"]\n[Black "${game.black}"]\n[Result "*"]\n\n${game.moves}`,
    stamp: String(index + 1).repeat(64),
    revision: "opening-fixture-revision",
    present: true,
}));
const openingTokens = Object.fromEntries(
    gameOpeningFixture.games.flatMap((game, index) => {
        const tokens = [
            ...["Event", "White", "Black"].map((tag) => ({
                type: "Header",
                value: { tag, value: game[tag.toLowerCase() as "event" | "white" | "black"] },
            })),
            { type: "San", value: index === 0 ? "e4" : "d4" },
            { type: "San", value: index === 0 ? "e5" : "d5" },
            { type: "Outcome", value: "*" },
        ];
        return [
            [game.moves, tokens],
            [openingPgnGames[index].pgn, tokens],
        ];
    }),
);
export const gameOpeningCommands: NonNullable<MockScenario["commands"]> = {
    ...databaseCommands(gameOpeningFixture.databaseId, "opening.db3", {
        title: gameOpeningFixture.databaseTitle,
        description: "Two distinct games",
        game_count: 2,
        player_count: 4,
        event_count: 2,
        storage_size: "4096",
        indexed: false,
    }),
    get_games: { result: { data: gameOpeningFixture.games, count: 2 } },
    get_db_game: { databaseGames: gameOpeningFixture.games },
    get_players: { result: { data: [], count: 0 } },
    get_tournaments: { result: { data: [], count: 0 } },
    read_games: { pgnGames: openingPgnGames },
    read_game: { pgnGames: openingPgnGames },
    file_revision: { result: "opening-fixture-revision" },
    lex_pgn: { pgnTokens: openingTokens },
};

/** Last-games Overview list for player id 1, newest first, distinct from the Games table. */
export const playerOverviewLastGames = [
    {
        id: 303,
        stamp: "c".repeat(64),
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        white: "Latest Opponent",
        white_id: 5,
        black: "First White",
        black_id: 1,
        event: "Latest event",
        event_id: 3,
        site: "?",
        site_id: 1,
        date: "2026.10.03",
        round: "3",
        result: "0-1",
        white_elo: 1480,
        black_elo: 1500,
        ply_count: 2,
        moves: "1. c4 e5 *",
        eco: "A20",
    },
    {
        ...gameOpeningFixture.games[0],
        result: "1-0",
        eco: "C50",
    },
] satisfies NormalizedGame[];

/** Populated split-layout coverage without changing the opening journeys' empty tab replies. */
export const databaseLayoutCommands: NonNullable<MockScenario["commands"]> = {
    ...gameOpeningCommands,
    get_games: {
        result: { data: gameOpeningFixture.games, count: 2 },
        lastGames: { data: playerOverviewLastGames, count: playerOverviewLastGames.length },
    },
    get_players: {
        result: { data: [{ id: 1, name: "First White", elo: 1500, game_count: 1 }], count: 1 },
    },
    get_tournaments: {
        result: {
            data: [
                {
                    id: 1,
                    name: "First event",
                    start_date: "2026.10.01",
                    end_date: "2026.10.03",
                    site: "Berlin International Chess Centre, Germany",
                    player_count: 4,
                    game_count: 2,
                    avg_elo: 1750,
                },
            ],
            count: 1,
        },
    },
    get_players_game_info: {
        result: {
            site_stats_data: [
                {
                    site: "?",
                    player: "First White",
                    daily: [
                        {
                            date: "2026.10.01",
                            time_control: "600",
                            won: 1,
                            drawn: 0,
                            lost: 0,
                            max_player_elo: 1500,
                        },
                    ],
                    openings: [
                        {
                            time_control: "600",
                            is_player_white: true,
                            opening: "Italian Game",
                            won: 1,
                            drawn: 0,
                            lost: 0,
                        },
                    ],
                    colors: [
                        {
                            time_control: "600",
                            is_player_white: true,
                            won: 1,
                            drawn: 0,
                            lost: 0,
                            rated_won: 1,
                            rated_drawn: 0,
                            rated_lost: 0,
                            opponent_elo_sum: 1400,
                        },
                    ],
                    latest: [
                        {
                            time_control: "600",
                            date: "2026.10.01",
                            time: null,
                            game_id: 101,
                            player_elo: 1500,
                        },
                    ],
                },
            ],
        },
    },
};

/** Listing and metadata answers for one available database, in their IPC wire shapes. */
export function databaseCommands(
    id: string,
    filename: string,
    info: Omit<DatabaseInfo, "filename">,
): NonNullable<MockScenario["commands"]> {
    return {
        list_workspace_databases: {
            result: {
                entries: [
                    {
                        handle: { id: { id }, kind: "database" },
                        filename,
                        availability: "available",
                    },
                ],
                unread: [],
            },
        },
        get_db_info: { result: { status: "ready", filename, ...info } },
    };
}

export function filesWorkspaceCommands(
    listResults: unknown[],
    overrides: NonNullable<MockScenario["commands"]> = {},
): NonNullable<MockScenario["commands"]> {
    return {
        issue_file_workspace: {
            result: {
                handle: filesWorkspaceFixture.workspace,
                displayName: "E2E collection",
                availability: "available",
            },
        },
        list_file_workspace: { results: listResults.map((entries) => ({ entries, unread: [] })) },
        list_workspace_trash: { result: { items: [], olderCount: 0, cursor: null } },
        ...overrides,
    };
}

type TauriEvent = { event: string; payload: unknown };

const fontScaleByProject: Record<string, number> = {
    "chessbase-guide-scaled": 200,
    "first-engine-install-scaled": 200,
    "workspace-tabs": 100,
    "board-keyboard": 100,
    "database-files": 200,
    "accounts-puzzles-engines": 200,
    "settings-responsive": 200,
    "font-scaled-breakpoints": 200,
    "async-errors": 200,
    "security-consent": 200,
    "file-freshness": 100,
    "files-preview": 100,
    "tree-recovery": 100,
    "notation-hierarchy-scaled": 200,
};

const localeByProject: Record<string, string> = {
    "async-errors": "de-DE",
};

const tauriBootstrap = () => {
    type Response = MockCommand;
    type Listener = { event: string; callback: number };
    type Actor = {
        owner: unknown;
        pending: { reject: (error: ErrorPayload) => void } | null;
    };
    const callbacks = new Map<number, (payload: unknown) => void>();
    const listeners: Listener[] = [];
    // Model only successfully started searches and their warm actors, not prepared reservations.
    const actors = new Map<string, Actor>();
    const actorKey = (engine: unknown, tab: unknown) => `${String(engine)}\u0000${String(tab)}`;
    const cancelSearch = (actor: Actor) => {
        actor.pending?.reject({
            tag: "backend-error",
            category: "cancellation",
            message: "Cancellation",
        });
        actor.pending = null;
    };
    let nextCallback = 1;
    let nextNativeTicket = 1;

    const defaultCommands: Record<string, Response> = {
        close_splashscreen: { result: null },
        revoke_legacy_lichess_token: { result: "revoked" },
        cancel_native_read: { result: null },
        reconcile_startup_path_owners: { result: null },
        reconcile_engine_attachments: { result: null },
        pending_engine_completions: { result: [] },
        acknowledge_engine_completion: { result: null },
        pending_account_completions: { result: [] },
        acknowledge_account_completion: { result: null },
        retire_engine_completion: { result: null },
        list_lichess_accounts: { result: [] },
        chessriddle_account: { error: "unavailable" },
        chessriddle_training_available: { result: false },
        chessriddle_training_settings: { error: "updateRequired" },
        chessriddle_training_motifs: { result: [] },
        chessriddle_open_website: { result: null },
        get_puzzle_workspace: {
            result: {
                root: { id: { id: "puzzle-root" }, kind: "puzzleRoot" },
                displayName: "E2E puzzles",
            },
        },
        load_practice_deck: { result: { epoch: "e2e-practice-epoch", deck: null } },
        practice_epoch: { result: { epoch: "e2e-practice-epoch", legacySuperseded: false } },
        record_practice_review: { result: 1 },
        sync_practice_positions: { result: 1 },
        reset_practice_deck: { result: 1 },
        load_practice_reviews: { result: { entries: [], nextCursor: null } },
        migrate_practice_deck: {
            result: {
                status: "alreadyMigrated",
                entries: 0,
                positions: 0,
                positionsDigest: "",
                entriesDigest: "",
            },
        },
        acknowledge_practice_orphans: { result: null },
        repair_practice_deck: { result: null },
        list_practice_decks: { result: { decks: [], anomalies: [] } },
        get_database_workspace: {
            result: {
                root: { id: { id: "database-root" }, kind: "databaseRoot" },
                displayName: "Databases",
            },
        },
        get_engine_workspace: {
            result: {
                root: { id: { id: "engine-root" }, kind: "engineRoot" },
                displayName: "Engines",
            },
        },
        list_workspace_databases: { result: { entries: [], unread: [] } },
        linked_collections_supported: { result: false },
        collection_for_database: { result: null },
        resolve_linked_game: { result: null },
        infer_game_orientation: { result: null },
        cancel_conversion: { result: true },
        release_conversion: { result: null },
        get_opening_from_fens: { result: [] },
        list_puzzle_databases: { result: [] },
        kill_engines: { result: null },
        kill_engine: { result: null },
        get_engine_config: { result: { name: "E2E Stockfish", options: [] } },
        stop_engine: { result: false },
        release_engine_search: { result: null },
        abort_game: { result: null },
        "plugin:app|version": { result: "0.0.0-e2e" },
        "plugin:app|tauri_version": { result: "2.10.0" },
        "plugin:cli|cli_matches": { result: { args: { file: { occurrences: 0, value: null } } } },
        "plugin:fs|exists": { result: true },
        "plugin:log|log": { result: null },
        "plugin:event|listen": { result: 1 },
        "plugin:event|unlisten": { result: null },
        "plugin:menu|new": { result: [1, "e2e-menu"] },
        "plugin:menu|set_as_app_menu": { result: null },
        "plugin:window|set_decorations": { result: null },
        "plugin:window|is_maximized": { result: false },
        "plugin:window|is_fullscreen": { result: false },
        // Production pair: close emits `tauri://close-requested` when a JS listener exists;
        // destroy is recorded and does not re-emit the close request.
        "plugin:window|close": { result: null },
        "plugin:window|destroy": { result: null },
    };

    const state = {
        commands: {} as Record<string, Response>,
        invocations: [] as { command: string; args: unknown }[],
        settledSearches: [] as MockEngineSearchState["settled"],
        stops: [] as MockEngineSearchState["stops"],
    };

    const emit = (event: string, payload: unknown) => {
        for (const listener of listeners.filter((entry) => entry.event === event)) {
            callbacks.get(listener.callback)?.({ event, id: 1, payload });
        }
    };

    // This is fixture-native state, kept apart from all three product owner values. A page
    // reload exercises real renderer startup and receipt application without reseeding it.
    const completionKey = "__E2E_ENGINE_COMPLETIONS__";
    const readCompletions = (): EngineCompletion[] =>
        JSON.parse(sessionStorage.getItem(completionKey) ?? "[]");
    const writeCompletions = (records: EngineCompletion[]) =>
        sessionStorage.setItem(completionKey, JSON.stringify(records));
    // Delayed workflow replies belong to their prepared download ticket until settlement.
    const pendingInstalls = new Map<string, () => void>();
    const accountCompletionKey = "__E2E_ACCOUNT_COMPLETIONS__";
    const readAccountCompletions = (): { id?: string; deletionPending?: boolean }[] =>
        JSON.parse(sessionStorage.getItem(accountCompletionKey) ?? "[]");
    const writeAccountCompletions = (records: { id?: string; deletionPending?: boolean }[]) =>
        sessionStorage.setItem(accountCompletionKey, JSON.stringify(records));

    const invoke = async (command: string, args: Record<string, unknown> = {}) => {
        state.invocations.push({ command, args });
        if (command === "prepare_native_read") return `e2e-native-read-${nextNativeTicket++}`;
        if (command === "prepare_conversion" && !state.commands[command])
            return `e2e-conversion-${nextNativeTicket++}`;
        if (command === "prepare_engine_search") return `e2e-engine-search-${nextNativeTicket++}`;
        if (command === "plugin:event|listen") {
            const callback = args.handler;
            if (typeof callback === "number")
                listeners.push({ event: String(args.event), callback });
        }

        // Native searches stay pending for their lifetime; scenarios can still script a response.
        if (command === "get_best_moves" && !state.commands[command]) {
            return new Promise<null>((_resolve, reject) => {
                const key = actorKey(args.id, args.tab);
                const predecessor = actors.get(key);
                if (predecessor) cancelSearch(predecessor);
                actors.set(key, { owner: args.generation, pending: { reject } });
            }).catch((error: ErrorPayload) => {
                state.settledSearches.push({
                    generation: args.generation,
                    outcome: error.category === "cancellation" ? "cancelled" : "failed",
                    error,
                });
                throw error;
            });
        }

        const response = state.commands[command] ?? defaultCommands[command];
        if (!response) {
            throw new Error(`Unexpected Tauri IPC command: ${command}`);
        }
        if (response.delay) {
            if (command === "install_engine_workflow") {
                const ticket = String(args.jobId);
                try {
                    await new Promise<void>((resolve, reject) => {
                        const timer = window.setTimeout(resolve, response.delay);
                        pendingInstalls.set(ticket, () => {
                            window.clearTimeout(timer);
                            reject({
                                tag: "backend-error",
                                category: "cancellation",
                                message: "Cancellation",
                            });
                        });
                    });
                } finally {
                    pendingInstalls.delete(ticket);
                }
            } else {
                await new Promise((resolve) => window.setTimeout(resolve, response.delay));
            }
        }
        const outcome = response.outcomes?.shift();
        const failure = outcome
            ? "error" in outcome
                ? outcome
                : undefined
            : "error" in response
              ? response
              : undefined;
        if (failure) {
            if (typeof failure.error === "string") throw new Error(failure.error);
            throw failure.error;
        }
        if (outcome) return outcome.result;
        if (command === "get_games" && response.lastGames) {
            const query = args.query as {
                player1?: unknown;
                sides?: unknown;
                options?: { sort?: unknown; direction?: unknown; pageSize?: unknown };
            } | null;
            if (
                query != null &&
                query.player1 != null &&
                query.sides === "Any" &&
                query.options?.sort === "date" &&
                query.options?.direction === "desc" &&
                query.options?.pageSize === 10
            ) {
                return response.lastGames;
            }
        }
        if (command === "get_db_game" && response.databaseGames) {
            const game = response.databaseGames.find((row) => row.id === args.gameId);
            return game ? { kind: "found", game } : { kind: "missing" };
        }
        if (command === "write_db_game") {
            const game = state.commands.get_db_game?.databaseGames?.find(
                (row) => row.id === args.gameId,
            );
            if (game) {
                const orientation = /\[Orientation "(white|black)"\]/.exec(String(args.pgn))?.[1];
                game.orientation = orientation as "white" | "black" | undefined;
                game.stamp = response.result as string;
            }
        }
        if (response.gameState)
            return {
                ...response.gameState,
                gameId: args.gameId,
                session: args.expectedSession ?? response.gameState.session,
            };
        if (response.pgnGames) {
            if (command === "read_games")
                return response.pgnGames.slice(Number(args.start), Number(args.end) + 1);
            if (command === "read_game") return response.pgnGames[Number(args.n)];
        }
        if (response.pgnTokens) return response.pgnTokens[String(args.pgn)];
        let retainedSearch = false;
        if (command === "kill_engines") {
            for (const [key, actor] of actors) {
                if (!key.endsWith(`\u0000${String(args.tab)}`)) continue;
                cancelSearch(actor);
                actors.delete(key);
            }
        } else {
            const key = actorKey(args.engine, args.tab);
            const actor = actors.get(key);
            if (
                actor &&
                (command === "kill_engine" ||
                    (command === "stop_engine" && args.expectedGeneration === null) ||
                    (command === "release_engine_search" && args.generation === actor.owner))
            ) {
                cancelSearch(actor);
                actors.delete(key);
            } else if (
                actor &&
                command === "stop_engine" &&
                args.expectedGeneration === actor.owner
            ) {
                retainedSearch = true;
                cancelSearch(actor);
            }
        }
        const result =
            command === "stop_engine" && !state.commands[command]
                ? retainedSearch
                : response.results?.length
                  ? response.results.shift()
                  : response.result;
        if (command === "cancel_download" && result === true) {
            pendingInstalls.get(String(args.id))?.();
        }
        if (command === "pending_engine_completions" && !state.commands[command])
            return readCompletions();
        if (command === "pending_account_completions" && !state.commands[command])
            return readAccountCompletions();
        if (
            command === "import_account_games" &&
            result &&
            typeof result === "object" &&
            "id" in result
        ) {
            const retained = readAccountCompletions();
            if (!retained.some((entry) => entry?.id === result.id))
                writeAccountCompletions([...retained, result]);
        }
        if (command === "acknowledge_account_completion" && !state.commands[command]) {
            writeAccountCompletions(
                readAccountCompletions().filter(
                    (entry) => entry.id !== args.id || entry.deletionPending,
                ),
            );
        }
        if (command === "install_engine_workflow" && response.engineInstall) {
            const records = readCompletions();
            const existing = records.find((record) => record.id === args.id);
            if (existing) return existing;
            const completion: EngineCompletion = {
                id: String(args.id),
                request: args.request as EngineInstallRequest,
                outcome: { state: "succeeded", result: result as InstalledEngineResult },
                retired: false,
            };
            writeCompletions([...records, completion]);
            return completion;
        }
        if (command === "acknowledge_engine_completion")
            writeCompletions(readCompletions().filter((record) => record.id !== args.id));
        if (command === "retire_engine_completion")
            writeCompletions(
                readCompletions().map((record) =>
                    record.id === args.id ? { ...record, retired: true } : record,
                ),
            );
        if (command === "stop_engine") {
            state.stops.push({
                engine: args.engine,
                tab: args.tab,
                expectedGeneration: args.expectedGeneration,
                result,
            });
        }
        if (command === "plugin:window|close") emit("tauri://close-requested", null);
        return result;
    };

    Object.assign(window, {
        __E2E_TAURI__: {
            configure(scenario: MockScenario) {
                state.commands = scenario.commands ?? {};
            },
            emit,
            failEngineSearch(engine: string, tab: string, generation: string, error: ErrorPayload) {
                const key = actorKey(engine, tab);
                const actor = actors.get(key);
                if (actor?.owner !== generation || !actor.pending) return false;
                actors.delete(key);
                actor.pending.reject(error);
                return true;
            },
            invocations: () => [...state.invocations],
            retainAccountCompletion(record: { id?: string; deletionPending?: boolean }) {
                const retained = readAccountCompletions();
                writeAccountCompletions([
                    ...retained.filter((entry) => entry.id !== record.id),
                    record,
                ]);
            },
            engineSearchState: (): MockEngineSearchState => ({
                pending: [...actors.values()]
                    .filter(({ pending }) => pending)
                    .map(({ owner }) => owner),
                settled: [...state.settledSearches],
                stops: [...state.stops],
            }),
        },
        __TAURI_OS_PLUGIN_INTERNALS__: {
            arch: "x86_64",
            eol: "\n",
            exe_extension: "",
            family: "unix",
            os_type: "linux",
            platform: "linux",
            version: "e2e",
        },
        __TAURI_EVENT_PLUGIN_INTERNALS__: {
            unregisterListener(event: string, callback: number) {
                const index = listeners.findIndex(
                    (entry) => entry.event === event && entry.callback === callback,
                );
                if (index >= 0) listeners.splice(index, 1);
            },
        },
        __TAURI_INTERNALS__: {
            metadata: {
                currentWindow: { label: "main" },
                currentWebview: { windowLabel: "main", label: "main" },
            },
            invoke,
            transformCallback(callback: (payload: unknown) => void, once = false) {
                const id = nextCallback++;
                callbacks.set(id, (payload) => {
                    callback(payload);
                    if (once) callbacks.delete(id);
                });
                return id;
            },
            unregisterCallback(id: number) {
                callbacks.delete(id);
            },
        },
    });
};

export const test = base.extend<{
    appLocale: string | undefined;
    assertNoHorizontalOverflow: () => Promise<void>;
    assertAccessible: () => Promise<void>;
    capture: (name: string) => Promise<void>;
    emitTauriEvent: (event: TauriEvent) => Promise<void>;
    mockScenario: (scenario: MockScenario) => Promise<void>;
}>({
    appLocale: [undefined, { option: true }],
    page: async ({ page, appLocale }, use, testInfo) => {
        const failures: string[] = [];
        const allowedOrigin = new URL(
            (testInfo.project.use.baseURL as string | undefined) ?? "http://127.0.0.1:4173",
        ).origin;
        const fontScale = fontScaleByProject[testInfo.project.name] ?? 100;
        const colorScheme = testInfo.project.use.colorScheme ?? "light";
        const locale = appLocale ?? localeByProject[testInfo.project.name] ?? "en-US";

        await page.addInitScript(tauriBootstrap);
        await page.addInitScript(
            ({ scale, scheme, locale }) => {
                const preserveStorageOnce =
                    sessionStorage.getItem("__E2E_PRESERVE_STORAGE_ONCE__") === "1";
                sessionStorage.removeItem("__E2E_PRESERVE_STORAGE_ONCE__");
                if (!preserveStorageOnce) {
                    localStorage.clear();
                    sessionStorage.clear();
                    localStorage.setItem("i18nextLng", locale);
                    localStorage.setItem("font-size", JSON.stringify(scale));
                    localStorage.setItem("mantine-color-scheme", scheme);
                }
            },
            { scale: fontScale, scheme: colorScheme, locale },
        );
        await page.context().route("**/*", async (route) => {
            const url = new URL(route.request().url());
            if (url.origin !== allowedOrigin) {
                failures.push(`Unexpected network request: ${url.href}`);
                await route.abort("blockedbyclient");
                return;
            }
            await route.continue();
        });
        page.on("console", (message) => {
            if (message.type() === "error") failures.push(`Console error: ${message.text()}`);
        });
        page.on("pageerror", (error) => failures.push(`Unhandled error: ${error.message}`));
        page.on("requestfailed", (request) => {
            const failure = localRequestFailure(request, allowedOrigin);
            if (failure !== null) failures.push(failure);
        });

        await use(page);

        if (failures.length > 0) {
            throw new Error(`Browser failures:\n${failures.join("\n")}`);
        }
    },

    mockScenario: async ({ page }, use) => {
        await use(async (scenario) => {
            await page.addInitScript((nextScenario) => {
                window.__E2E_TAURI__.configure(nextScenario);
            }, scenario);
        });
    },

    emitTauriEvent: async ({ page }, use) => {
        await use(async ({ event, payload }) => {
            await page.evaluate(
                ({ event: eventName, payload: eventPayload }) => {
                    window.__E2E_TAURI__.emit(eventName, eventPayload);
                },
                { event, payload },
            );
        });
    },

    assertNoHorizontalOverflow: async ({ page }, use) => {
        await use(async () => {
            const dimensions = await page.evaluate(() => ({
                width: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
                viewport: window.innerWidth,
            }));
            expect(
                dimensions.width,
                `horizontal overflow: ${dimensions.width}px > ${dimensions.viewport}px`,
            ).toBeLessThanOrEqual(dimensions.viewport);
        });
    },

    assertAccessible: async ({ page }, use) => {
        await use(async () => {
            const results = await new AxeBuilder({ page })
                // The app owns these semantic/layout checks; no generic third-party exception is hidden.
                .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
                .analyze();
            expect(
                results.violations,
                results.violations
                    .map(
                        (violation) =>
                            `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`,
                    )
                    .join("\n"),
            ).toEqual([]);
        });
    },

    capture: async ({ page }, use, testInfo) => {
        await use(async (name) => {
            await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
        });
    },
});

export { expect };

declare global {
    interface Window {
        __TAURI_INTERNALS__: {
            invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
        };
        __E2E_TAURI__: {
            configure(scenario: MockScenario): void;
            emit(event: string, payload: unknown): void;
            invocations(): { command: string; args: unknown }[];
            retainAccountCompletion(record: { id?: string; deletionPending?: boolean }): void;
            engineSearchState(): MockEngineSearchState;
            failEngineSearch(
                engine: string,
                tab: string,
                generation: string,
                error: ErrorPayload,
            ): boolean;
        };
    }
}
