import { Chessground } from "@lichess-org/chessground";
import type { Api } from "@lichess-org/chessground/api";
import type { DrawShape } from "@lichess-org/chessground/draw";
import { expect, test } from "vitest";
import { pgnDrawingBrushes } from "@/utils/drawings";
import { installPatchedChessgroundHarness } from "@/tests/patchedChessground";

// SVG ids are document-global. When two boards wrote the same `arrowhead-g`, WebKit bound an
// arrow to the other board's marker and drew a bare line once that board unmounted. jsdom does not
// reproduce that binding, so these tests pin its cause: every id is unique and owned by its svg.
const flushFrames = installPatchedChessgroundHarness();

const SHAPES: DrawShape[] = [
    { orig: "e2", dest: "e4", brush: "green" },
    { orig: "d2", dest: "d4", brush: "green", below: true },
    { orig: "g1", dest: "f3", brush: "green", modifiers: { hilite: "#ffffff" } },
];

function mountBoard(): { element: HTMLElement; api: Api } {
    const element = document.createElement("div");
    document.body.append(element);
    const api = Chessground(element, { drawable: { brushes: pgnDrawingBrushes } });
    api.setShapes(SHAPES);
    flushFrames();
    return { element, api };
}

/** Every `url(#…)` reference in the board, with the svg that holds the referencing element. */
function references(element: HTMLElement): { id: string; svg: SVGSVGElement }[] {
    const found: { id: string; svg: SVGSVGElement }[] = [];
    for (const node of element.querySelectorAll<SVGElement>("[marker-end], [filter]")) {
        const value = node.getAttribute("marker-end") ?? node.getAttribute("filter") ?? "";
        const id = /^url\(#(.+)\)$/.exec(value)?.[1];
        if (!id || !node.ownerSVGElement) throw new Error(`unexpected reference ${value}`);
        found.push({ id, svg: node.ownerSVGElement });
    }
    return found;
}

function expectOwnedReferences(element: HTMLElement) {
    const refs = references(element);
    // Three arrows, one hilite glow line and its blur filter group.
    expect(refs.length).toBe(5);
    for (const { id, svg } of refs) {
        expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
        expect(svg.querySelector(`defs > [id="${id}"]`)).not.toBeNull();
    }
}

test("every board and plane resolves its arrow markers and filter inside its own svg", () => {
    const first = mountBoard();
    const second = mountBoard();
    expectOwnedReferences(first.element);
    expectOwnedReferences(second.element);
    first.api.destroy();
    second.api.destroy();
});

test("a full redraw rebuilds the svg with the board's own ids", () => {
    const board = mountBoard();
    const other = mountBoard();
    board.api.redrawAll();
    expectOwnedReferences(board.element);
    expectOwnedReferences(other.element);
    board.api.destroy();
    other.api.destroy();
});
