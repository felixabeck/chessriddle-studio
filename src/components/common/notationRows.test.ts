import { describe, expect, test } from "vitest";
import { fixtureNode } from "@/tests/treeFixtures";
import {
    buildNotationRows,
    collapseKeysOnPath,
    NOTATION_ROW_MAX_MOVES,
    pathForNotationNode,
    variationCollapseKey,
    type NotationRow,
} from "./notationRows";
import { defaultTree, getNodeAtPath, type TreeNode } from "@/utils/treeReducer";
import { formatMoveNumber } from "@/utils/format";

function variedTree() {
    const root = defaultTree().root;
    const e4 = fixtureNode("e4");
    const e5 = fixtureNode("e5", { halfMoves: 2 });
    const d4 = fixtureNode("d4");
    const c5 = fixtureNode("c5", { halfMoves: 2 });
    const nf3 = fixtureNode("Nf3", { halfMoves: 3 });
    const nc6 = fixtureNode("Nc6", { halfMoves: 4 });
    const bb5 = fixtureNode("Bb5", { halfMoves: 5 });
    const a6 = fixtureNode("a6", { halfMoves: 6 });
    root.children = [e4, d4];
    e4.children = [e5, c5];
    e5.children = [nf3];
    nf3.children = [nc6];
    nc6.children = [bb5];
    bb5.children = [a6];
    return { root, e4, e5, d4, c5, nf3, nc6, bb5, a6 };
}

function moveNames(rows: NotationRow[]) {
    return rows.flatMap((row) => {
        if (row.type === "moves") return row.moves.map((move) => move.node.san);
        if (row.type === "table") {
            return [row.white?.node.san, row.black?.node.san].filter(
                (san): san is string => san !== undefined,
            );
        }
        return [];
    });
}

describe("buildNotationRows", () => {
    test.each([false, true])(
        "numbers a resumed black move after expanded and collapsed variations (analysis: %s)",
        (analysis) => {
            const tree = variedTree();
            tree.e5.children.push(fixtureNode("Bc4", { halfMoves: 3 }));
            if (analysis) tree.e5.gameEnd = {};
            for (const collapsed of [false, true]) {
                const model = buildNotationRows(tree.root, {
                    tableView: false,
                    showComments: false,
                    showDiagrams: true,
                    showVariations: true,
                    collapsedVariations: collapsed
                        ? new Set([variationCollapseKey(tree.root, [0, 0])])
                        : undefined,
                });
                const row = model.rows[model.rowForNode.get(tree.nc6)!];
                expect(row).toMatchObject({
                    type: "moves",
                    depth: 0,
                    moves: [
                        { node: tree.nc6, first: true, analysis },
                        { node: tree.bb5, first: false },
                        { node: tree.a6, first: false },
                    ],
                });
                if (row.type !== "moves") throw new Error("Expected inline notation");
                const move = row.moves[0];
                expect(
                    `${move.first ? formatMoveNumber(move.node.halfMoves) : ""} ${move.node.san}`,
                ).toBe("2... Nc6");
            }
        },
    );

    test("anchors resumed black numbering to a black-to-move root FEN", () => {
        const root = defaultTree("8/8/8/8/8/8/8/K6k b - - 0 23").root;
        const first = fixtureNode("Kh2", { halfMoves: root.halfMoves + 1 });
        const white = fixtureNode("Ka2", { halfMoves: first.halfMoves + 1 });
        const alternative = fixtureNode("Kb1", { halfMoves: white.halfMoves });
        const resumed = fixtureNode("Kh3", { halfMoves: white.halfMoves + 1 });
        root.children = [first];
        first.children = [white, alternative];
        white.children = [resumed];
        const model = buildNotationRows(root, {
            tableView: false,
            showComments: false,
            showDiagrams: true,
            showVariations: true,
        });
        const row = model.rows[model.rowForNode.get(resumed)!];
        expect(row).toMatchObject({ type: "moves", moves: [{ node: resumed, first: true }] });
        expect(formatMoveNumber(resumed.halfMoves)).toBe("24...");
    });

    test.each([false, true])(
        "places the end after its move, comment and alternatives before analysis (tableView: %s)",
        (tableView) => {
            const tree = variedTree();
            tree.e5.gameEnd = { termination: "Abandoned" };
            tree.e5.comment = "Last played move";
            const laterAlternative = fixtureNode("Nc3", { halfMoves: 3 });
            const nestedAlternative = fixtureNode("d3", { halfMoves: 3 });
            tree.e5.children.push(laterAlternative);
            tree.c5.children = [fixtureNode("c3", { halfMoves: 3 }), nestedAlternative];
            const model = buildNotationRows(tree.root, {
                tableView,
                showComments: true,
                showDiagrams: true,
                showVariations: true,
            });
            const boundary = model.rows.findIndex((row) => row.type === "gameEnd");
            expect(model.rows.filter((row) => row.type === "gameEnd")).toEqual([
                { type: "gameEnd", hasAnalysis: true },
            ]);
            expect(model.rowForNode.get(tree.e5)).toBeLessThan(boundary);
            expect(model.rowForNode.get(tree.c5)).toBeLessThan(boundary);
            expect(model.rowForNode.get(nestedAlternative)).toBeLessThan(boundary);
            expect(model.rowForNode.get(tree.nf3)).toBeGreaterThan(boundary);
            const expectedComments = tableView
                ? [
                      {
                          type: "comment",
                          depth: 0,
                          comment: "Last played move",
                          annotatedNode: tree.e5,
                      },
                  ]
                : [];
            expect(model.rows.slice(0, boundary).filter((row) => row.type === "comment")).toEqual(
                expectedComments,
            );
            for (const row of model.rows) {
                const moves =
                    row.type === "moves"
                        ? row.moves
                        : row.type === "table"
                          ? [row.white, row.black].filter((move) => move !== null)
                          : [];
                for (const move of moves) {
                    expect(move.analysis).toBe(
                        [tree.nf3, tree.nc6, tree.bb5, tree.a6, laterAlternative].includes(
                            move.node,
                        ),
                    );
                }
            }
        },
    );

    test.each([false, true])(
        "splits a white end before the black reply even without comments or variations (tableView: %s)",
        (tableView) => {
            const tree = variedTree();
            tree.e4.gameEnd = {};
            const model = buildNotationRows(tree.root, {
                tableView,
                showComments: false,
                showDiagrams: true,
                showVariations: false,
            });
            expect(model.rows[1]).toEqual({ type: "gameEnd", hasAnalysis: true });
            expect(model.rowForNode.get(tree.e4)).toBe(0);
            expect(model.rowForNode.get(tree.e5)).toBe(2);
            const expectedFirstRow = tableView
                ? {
                      type: "table",
                      white: { node: tree.e4, analysis: false },
                      black: null,
                      splitRow: true,
                  }
                : { type: "moves", moves: [{ node: tree.e4, analysis: false }] };
            expect(model.rows[0]).toMatchObject(expectedFirstRow);
        },
    );

    test.each([false, true])(
        "keeps a leaf end and collapsed alternatives before its boundary (tableView: %s)",
        (tableView) => {
            const tree = variedTree();
            tree.e5.gameEnd = {};
            tree.e5.children = [];
            const model = buildNotationRows(tree.root, {
                tableView,
                showComments: true,
                showDiagrams: true,
                showVariations: true,
                collapsedVariations: new Set(["a3 a6 h3", variationCollapseKey(tree.root, [0])]),
            });
            expect(model.rows.at(-1)).toEqual({ type: "gameEnd", hasAnalysis: false });
            expect(model.rows.at(-2)).toMatchObject({
                type: "variation",
                parent: tree.e4,
                collapsed: true,
            });
        },
    );

    test.each([false, true])(
        "ignores root and variation flags without an effective end (tableView: %s)",
        (tableView) => {
            const tree = variedTree();
            tree.root.gameEnd = {};
            tree.c5.gameEnd = {};
            const model = buildNotationRows(tree.root, {
                tableView,
                showComments: true,
                showDiagrams: true,
                showVariations: true,
            });
            expect(model.rows.some((row) => row.type === "gameEnd")).toBe(false);
            expect(
                model.rows
                    .flatMap((row) =>
                        row.type === "moves"
                            ? row.moves
                            : row.type === "table"
                              ? [row.white, row.black].filter((move) => move !== null)
                              : [],
                    )
                    .some((move) => move.analysis),
            ).toBe(false);
        },
    );

    test("collapses a variation by the full move sequence, not SAN or an index path", () => {
        const root = defaultTree().root;
        const e4 = fixtureNode("e4");
        const e5 = fixtureNode("e5", { halfMoves: 2 });
        const nf3 = fixtureNode("Nf3", { halfMoves: 3 });
        const nc6 = fixtureNode("Nc6", { halfMoves: 4 });
        const bc5 = fixtureNode("Bc5", { halfMoves: 4 });
        const d4 = fixtureNode("d4");
        const d4e5 = fixtureNode("e5", { halfMoves: 2 });
        const d4nf3 = fixtureNode("Nf3", { halfMoves: 3 });
        const d4nc6 = fixtureNode("Nc6", { halfMoves: 4 });
        const d4d6 = fixtureNode("d6", { halfMoves: 4 });
        root.children = [e4, d4];
        e4.children = [e5];
        e5.children = [nf3];
        nf3.children = [nc6, bc5];
        d4.children = [d4e5];
        d4e5.children = [d4nf3];
        d4nf3.children = [d4nc6, d4d6];

        expect(variationCollapseKey(root, [0, 0, 0])).toBe("e4 e5 Nf3");

        const model = buildNotationRows(root, {
            tableView: false,
            showComments: false,
            showDiagrams: true,
            showVariations: true,
            collapsedVariations: new Set(["e4 e5 Nf3"]),
        });
        const variationRows = model.rows.filter((row) => row.type === "variation");
        expect(variationRows.filter((row) => row.parent === nf3)).toEqual([
            expect.objectContaining({ type: "variation", parent: nf3, collapsed: true }),
        ]);
        expect(variationRows.filter((row) => row.parent === d4nf3)).toEqual([
            expect.objectContaining({ type: "variation", parent: d4nf3, collapsed: false }),
        ]);
        expect(model.rowForNode.has(bc5)).toBe(false);
        expect(model.rowForNode.has(d4d6)).toBe(true);
        expect(moveNames(model.rows)).toEqual([
            "e4",
            "d4",
            "e5",
            "Nf3",
            "Nc6",
            "d6",
            "e5",
            "Nf3",
            "Nc6",
        ]);
    });

    test("renders mainline and nested variations in order", () => {
        const tree = variedTree();
        const result = buildNotationRows(tree.root, {
            showVariations: true,
            showComments: true,
            showDiagrams: true,
            tableView: false,
        });

        expect(moveNames(result.rows)).toEqual(["e4", "d4", "e5", "c5", "Nf3", "Nc6", "Bb5", "a6"]);
        expect(result.rows.filter((row) => row.type === "variation")).toHaveLength(2);
        expect(
            result.rows.filter((row) => row.type === "variation").map((row) => row.parent),
        ).toEqual([tree.root, tree.e4]);
    });

    test("honours comment and variation visibility", () => {
        const tree = variedTree();
        tree.root.comment = "root";
        tree.e4.comment = "after e4";

        const hidden = buildNotationRows(tree.root, {
            showVariations: false,
            showComments: false,
            showDiagrams: true,
            tableView: false,
        });
        expect(moveNames(hidden.rows)).toEqual(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"]);
        expect(hidden.rows.some((row) => row.type === "comment")).toBe(false);

        const shown = buildNotationRows(tree.root, {
            showVariations: true,
            showComments: true,
            showDiagrams: true,
            tableView: false,
        });
        expect(
            shown.rows.filter((row) => row.type === "comment").map((row) => row.comment),
        ).toEqual(["root"]);
        expect(moveNames(shown.rows)).toContain("e4");
        expect(tree.e4.comment).toBe("after e4");
        const collapsed = buildNotationRows(tree.root, {
            showVariations: true,
            showComments: true,
            showDiagrams: true,
            tableView: false,
            collapsedVariations: new Set([variationCollapseKey(tree.root, [0])]),
        });
        expect(moveNames(collapsed.rows)).not.toContain("c5");
        expect(collapsed.rows.some((row) => row.type === "variation")).toBe(true);
    });

    test("splits long runs at the named boundary", () => {
        const root = defaultTree().root;
        let parent = root;
        for (let index = 1; index <= NOTATION_ROW_MAX_MOVES * 2 + 1; index += 1) {
            const child = fixtureNode(`m${index}`, { halfMoves: index });
            parent.children = [child];
            parent = child;
        }

        const rows = buildNotationRows(root, {
            showVariations: false,
            showComments: false,
            showDiagrams: true,
            tableView: false,
        }).rows.filter((row) => row.type === "moves");
        expect(rows.map((row) => row.moves.length)).toEqual([
            NOTATION_ROW_MAX_MOVES,
            NOTATION_ROW_MAX_MOVES,
            1,
        ]);
    });

    test("keeps every commented move in one inline run and preserves table comment rows", () => {
        const tree = variedTree();
        const mainline = [tree.e4, tree.e5, tree.nf3, tree.nc6, tree.bb5, tree.a6];
        for (const node of mainline) node.comment = `After ${node.san}`;
        tree.nc6.comment = "After Nc6\n\nA second paragraph";
        const options = {
            showVariations: false,
            showComments: true,
            showDiagrams: true,
            tableView: false,
        };
        const inline = buildNotationRows(tree.root, options);
        expect(inline.rows).toHaveLength(1);
        expect(inline.rows[0]).toMatchObject({
            type: "moves",
            moves: mainline.map((node, index) => ({ node, first: index === 0 })),
        });
        for (const node of mainline) expect(inline.rowForNode.get(node)).toBe(0);

        const table = buildNotationRows(tree.root, { ...options, tableView: true });
        expect(table.rows.map((row) => row.type)).toEqual(
            mainline.flatMap(() => ["table", "comment"]),
        );
        expect(
            table.rows.filter((row) => row.type === "comment").map((row) => row.comment),
        ).toEqual(mainline.map((node) => node.comment));
        expect(moveNames(table.rows)).toEqual(mainline.map((node) => node.san));
    });

    test("table variations keep starting and move comments in one inline run", () => {
        const tree = variedTree();
        tree.root.children = [tree.e4];
        tree.c5.startingComment = "Before c5 [%evp 0,34]";
        tree.c5.comment = "After c5";
        const nc3 = fixtureNode("Nc3", { halfMoves: 3 });
        nc3.comment = "After Nc3";
        tree.c5.children = [nc3];
        const result = buildNotationRows(tree.root, {
            showVariations: true,
            showComments: true,
            showDiagrams: true,
            tableView: true,
        });

        const variationRows = result.rows.filter((row) => row.type === "moves");
        expect(variationRows).toHaveLength(1);
        expect(variationRows[0]).toMatchObject({
            variationParent: tree.e4,
            moves: [
                { node: tree.c5, first: true, startingComment: "Before c5" },
                { node: nc3, first: false },
            ],
        });
        expect(result.rows.some((row) => row.type === "comment")).toBe(false);
    });

    test.each([false, true])(
        "table black variations appear once after their move with next-white alternatives %s",
        (withWhiteAlternative) => {
            const tree = variedTree();
            tree.root.children = [tree.e4];
            tree.nf3.children = [];
            const nc3 = fixtureNode("Nc3", { halfMoves: 3 });
            if (withWhiteAlternative) tree.e5.children.push(nc3);
            const result = buildNotationRows(tree.root, {
                showVariations: true,
                showComments: true,
                showDiagrams: true,
                tableView: true,
            });

            const blackRow = result.rowForNode.get(tree.e5)!;
            expect(result.rows[blackRow + 1]).toMatchObject({
                type: "variation",
                parent: tree.e4,
            });
            expect(result.rows[blackRow + 2]).toMatchObject({
                type: "moves",
                moves: [{ node: tree.c5 }],
            });
            expect(moveNames(result.rows)).toEqual(
                withWhiteAlternative ? ["e4", "e5", "c5", "Nf3", "Nc3"] : ["e4", "e5", "c5", "Nf3"],
            );
            const variations = result.rows.filter((row) => row.type === "variation");
            expect(variations.map((row) => row.parent)).toEqual(
                withWhiteAlternative ? [tree.e4, tree.e5] : [tree.e4],
            );
            expect(result.rows.every((row) => row.type !== "moves" || row.moves.length > 0)).toBe(
                true,
            );
            const whiteRow = result.rowForNode.get(tree.nf3)!;
            expect(result.rows.slice(whiteRow + 1)).toMatchObject(
                withWhiteAlternative
                    ? [
                          { type: "variation", parent: tree.e5 },
                          { type: "moves", moves: [{ node: nc3 }] },
                      ]
                    : [],
            );
        },
    );

    test("table rows preserve split rows and ellipses around comments and variations", () => {
        const tree = variedTree();
        tree.e4.comment = "white comment";
        const result = buildNotationRows(tree.root, {
            showVariations: true,
            showComments: true,
            showDiagrams: true,
            tableView: true,
        });
        const tableRows = result.rows.filter((row) => row.type === "table");
        expect(tableRows[0]).toMatchObject({ moveNumber: 1, splitRow: true });
        expect(tableRows[0].white?.node).toBe(tree.e4);
        expect(tableRows[0].black).toBeNull();
        expect(result.rows.some((row) => row.type === "variation")).toBe(true);
        expect(tableRows.some((row) => row.black?.node === tree.e5)).toBe(true);
    });

    test("anchors black-to-move numbering to halfMoves", () => {
        const root = defaultTree("8/8/8/8/8/8/8/K6k b - - 0 23").root;
        const blackMove = fixtureNode("...Kh7", { halfMoves: root.halfMoves + 1 });
        root.children = [blackMove];
        const rows = buildNotationRows(root, {
            showVariations: false,
            showComments: false,
            showDiagrams: true,
            tableView: false,
        }).rows;
        expect(rows[0]).toMatchObject({ type: "moves" });
        expect((rows[0] as Extract<NotationRow, { type: "moves" }>).moves[0].first).toBe(true);
        expect(blackMove.halfMoves).toBe(46);
    });

    test.each([false, true])(
        "places a black-to-move start's end before later analysis (tableView: %s)",
        (tableView) => {
            const root = defaultTree("8/8/8/8/8/8/8/K6k b - - 0 23").root;
            const end = fixtureNode("Kh2", { halfMoves: root.halfMoves + 1 });
            const white = fixtureNode("Ka2", { halfMoves: end.halfMoves + 1 });
            const black = fixtureNode("Kh3", { halfMoves: white.halfMoves + 1 });
            root.children = [end];
            end.gameEnd = {};
            end.children = [white];
            white.children = [black];
            const model = buildNotationRows(root, {
                tableView,
                showComments: false,
                showDiagrams: true,
                showVariations: false,
            });
            expect(end.halfMoves).toBe(46);
            expect(model.rowForNode.get(end)).toBe(0);
            expect(model.rows).toHaveLength(3);
            expect(model.rows[1]).toEqual({ type: "gameEnd", hasAnalysis: true });
            expect(model.rowForNode.get(white)).toBe(2);
            expect(model.rowForNode.get(black)).toBe(2);
            expect(model.rows[0]).toMatchObject(
                tableView
                    ? {
                          type: "table",
                          moveNumber: 23,
                          white: null,
                          black: { node: end, analysis: false },
                      }
                    : { type: "moves", moves: [{ node: end, first: true, analysis: false }] },
            );
            expect(model.rows[2]).toMatchObject(
                tableView
                    ? {
                          type: "table",
                          moveNumber: 24,
                          white: { node: white, analysis: true },
                          black: { node: black, analysis: true },
                      }
                    : {
                          type: "moves",
                          moves: [
                              { node: white, analysis: true },
                              { node: black, analysis: true },
                          ],
                      },
            );
        },
    );

    test("reconstructs every varied-tree path without storing paths on tokens", () => {
        const tree = variedTree();
        const result = buildNotationRows(tree.root, {
            showVariations: true,
            showComments: true,
            showDiagrams: true,
            tableView: false,
        });
        const expected = new Map<TreeNode, number[]>();
        const stack: { node: TreeNode; path: number[] }[] = [{ node: tree.root, path: [] }];
        while (stack.length > 0) {
            const item = stack.pop()!;
            expected.set(item.node, item.path);
            for (let index = item.node.children.length - 1; index >= 0; index -= 1) {
                stack.push({ node: item.node.children[index], path: [...item.path, index] });
            }
        }
        for (const [node, path] of expected) {
            expect(pathForNotationNode(result.index, node)).toEqual(path);
        }
        const tokens = result.rows.flatMap((row) => (row.type === "moves" ? row.moves : []));
        expect(tokens.every((move) => !Object.hasOwn(move, "path"))).toBe(true);
        expect(getNodeAtPath(tree.root, pathForNotationNode(result.index, tree.c5)!)).toBe(tree.c5);
    });

    test("builds a 25,000-ply line iteratively", () => {
        const root = defaultTree().root;
        let parent = root;
        for (let index = 1; index <= 25_000; index += 1) {
            const child = fixtureNode(`ply-${index}`, { halfMoves: index });
            parent.children = [child];
            parent = child;
        }
        const result = buildNotationRows(root, {
            showVariations: false,
            showComments: false,
            showDiagrams: true,
            tableView: false,
        });
        expect(result.rows.filter((row) => row.type === "moves").length).toBeGreaterThan(700);
        expect(result.rows.some((row) => row.type === "moves" && "path" in row.moves[0])).toBe(
            false,
        );
    });
});

describe("variation starting comments", () => {
    test("show their prose before the variation's first move, without commands", () => {
        const tree = variedTree();
        tree.d4.startingComment = "Also good: [%evp 0,34]";
        const result = buildNotationRows(tree.root, {
            showVariations: true,
            showComments: true,
            showDiagrams: true,
            tableView: false,
        });

        expect(result.rows.some((row) => row.type === "comment")).toBe(false);
        const row = result.rows[result.rowForNode.get(tree.d4)!];
        expect(row).toMatchObject({
            type: "moves",
            moves: [{ node: tree.d4, first: true, startingComment: "Also good:" }],
        });
    });

    test("add no row when the starting comment is only commands or comments are hidden", () => {
        const tree = variedTree();
        tree.d4.startingComment = "[%evp 0,34]";
        const options = {
            showVariations: true,
            showComments: true,
            showDiagrams: true,
            tableView: false,
        };
        const commandsOnly = buildNotationRows(tree.root, options);
        expect(commandsOnly.rows.some((r) => r.type === "comment")).toBe(false);
        const commandRow = commandsOnly.rows[commandsOnly.rowForNode.get(tree.d4)!];
        expect(commandRow).toMatchObject({ type: "moves", moves: [{ startingComment: "" }] });

        tree.d4.startingComment = "Also good:";
        const hidden = buildNotationRows(tree.root, { ...options, showComments: false });
        expect(hidden.rows.some((r) => r.type === "comment")).toBe(false);
        const hiddenRow = hidden.rows[hidden.rowForNode.get(tree.d4)!];
        expect(hiddenRow).toMatchObject({ type: "moves", moves: [{ startingComment: "" }] });
    });
});

describe("starting comments off a variation's first move", () => {
    function commentBefore(rows: NotationRow[], node: TreeNode) {
        const index = rows.findIndex(
            (row) =>
                (row.type === "moves" && row.moves.some((move) => move.node === node)) ||
                (row.type === "table" && (row.white?.node === node || row.black?.node === node)),
        );
        return rows[index - 1];
    }

    test("inline, a promoted move keeps its comment in front of it mid-line", () => {
        const tree = variedTree();
        tree.nc6.startingComment = "Kept after promotion [%evp 1]";
        const result = buildNotationRows(tree.root, {
            showVariations: true,
            showComments: true,
            showDiagrams: true,
            tableView: false,
        });

        expect(result.rows.some((row) => row.type === "comment")).toBe(false);
        const row = result.rows.find(
            (r) => r.type === "moves" && r.moves.some((move) => move.node === tree.nc6),
        );
        expect(row?.type === "moves" && row.moves.map((move) => move.node)).toEqual([
            tree.nf3,
            tree.nc6,
            tree.bb5,
            tree.a6,
        ]);
        expect(row?.type === "moves" && row.moves[1]).toMatchObject({
            node: tree.nc6,
            first: true,
            startingComment: "Kept after promotion",
        });
    });

    test.each([
        ["a white move", "bb5", "nc6"],
        ["a black move", "nc6", "nf3"],
    ] as const)("in table view, %s keeps its comment in front of its row", (_, key, parent) => {
        const tree = variedTree();
        tree[key].startingComment = "Before this move";
        const result = buildNotationRows(tree.root, {
            showVariations: true,
            showComments: true,
            showDiagrams: true,
            tableView: true,
        });

        // A comment before a move annotates the position the move is played from.
        expect(commentBefore(result.rows, tree[key])).toMatchObject({
            type: "comment",
            comment: "Before this move",
            annotatedNode: tree[parent],
        });
    });
});

describe("diagram rows", () => {
    const options = {
        showVariations: true,
        showComments: true,
        showDiagrams: true,
        tableView: false,
    };
    const shape = (rows: NotationRow[]) =>
        rows.map((row) => {
            if (row.type === "moves") return row.moves.map((move) => move.node.san).join(" ");
            if (row.type === "table")
                return `${row.white?.node.san ?? "…"}|${row.black?.node.san ?? (row.splitRow ? "…" : "")}`;
            if (row.type === "diagram") return `[${row.node.san ?? "root"}:${row.comment}]`;
            return row.type;
        });

    test("an inline diagram ends its move's row, sits before that move's alternatives and carries the comment", () => {
        const tree = variedTree();
        tree.e5.diagram = true;
        tree.e5.comment = "Key";
        const { rows } = buildNotationRows(tree.root, options);
        expect(shape(rows)).toEqual([
            "e4",
            "variation",
            "d4",
            "e5",
            "[e5:Key]",
            "variation",
            "c5",
            "Nf3 Nc6 Bb5 a6",
        ]);
        const e5Row = rows[3];
        if (e5Row.type !== "moves") throw new Error("expected a moves row");
        // The cell leaves the comment to the diagram row.
        expect(e5Row.moves[0].diagram).toBe(true);
        const resumed = rows[7];
        if (resumed.type !== "moves") throw new Error("expected a moves row");
        expect(resumed.moves[0].first).toBe(true);
        expect(resumed.moves[0].diagram).toBe(false);
    });

    test("a diagram inside a variation keeps the variation's depth, and a leaf diagram closes the line", () => {
        const tree = variedTree();
        tree.c5.diagram = true;
        tree.a6.diagram = true;
        const { rows } = buildNotationRows(tree.root, options);
        expect(shape(rows)).toEqual([
            "e4",
            "variation",
            "d4",
            "e5",
            "variation",
            "c5",
            "[c5:]",
            "Nf3 Nc6 Bb5 a6",
            "[a6:]",
        ]);
        expect(rows[6]).toMatchObject({ type: "diagram", depth: 1, node: tree.c5 });
        expect(rows[8]).toMatchObject({ type: "diagram", depth: 0, node: tree.a6 });
    });

    test("hidden diagrams leave the rows exactly as without a marker", () => {
        const marked = variedTree();
        marked.e5.diagram = true;
        marked.e5.comment = "Key";
        const plain = variedTree();
        plain.e5.comment = "Key";
        for (const tableView of [false, true]) {
            const hidden = { ...options, tableView, showDiagrams: false };
            expect(shape(buildNotationRows(marked.root, hidden).rows)).toEqual(
                shape(buildNotationRows(plain.root, hidden).rows),
            );
            const flagged = buildNotationRows(marked.root, hidden).rows.flatMap((row) =>
                row.type === "moves" ? row.moves.filter((move) => move.diagram) : [],
            );
            expect(flagged).toEqual([]);
        }
    });

    test("hidden comments keep the board and drop its text", () => {
        const tree = variedTree();
        tree.e5.diagram = true;
        tree.e5.comment = "Key";
        const { rows } = buildNotationRows(tree.root, { ...options, showComments: false });
        expect(shape(rows)).toContain("[e5:]");
    });

    test("table view splits a White move with a diagram and no comment from its Black reply", () => {
        const tree = variedTree();
        tree.e4.children = [tree.e5];
        tree.root.children = [tree.e4];
        tree.e4.diagram = true;
        const { rows } = buildNotationRows(tree.root, { ...options, tableView: true });
        expect(shape(rows).slice(0, 4)).toEqual(["e4|…", "[e4:]", "…|e5", "Nf3|Nc6"]);
    });

    test("table view replaces a marked move's comment row with its diagram row", () => {
        const tree = variedTree();
        tree.e4.children = [tree.e5];
        tree.root.children = [tree.e4];
        tree.e5.diagram = true;
        tree.e5.comment = "Reply";
        tree.nf3.comment = "Plain";
        const { rows } = buildNotationRows(tree.root, { ...options, tableView: true });
        expect(shape(rows)).toEqual(["e4|e5", "[e5:Reply]", "Nf3|…", "comment", "…|Nc6", "Bb5|a6"]);
    });

    test.each([false, true])(
        "a marked root gets a diagram row with or without a comment (tableView: %s)",
        (tableView) => {
            const tree = variedTree();
            tree.root.diagram = true;
            const bare = buildNotationRows(tree.root, { ...options, tableView }).rows;
            expect(shape(bare)[0]).toBe("[root:]");
            tree.root.comment = "Start";
            const commented = buildNotationRows(tree.root, { ...options, tableView }).rows;
            expect(shape(commented).slice(0, 2)).toEqual([
                "[root:Start]",
                tableView ? "e4|…" : "e4",
            ]);
        },
    );

    test("a diagram row is not the scroll target of its move", () => {
        const tree = variedTree();
        tree.e5.diagram = true;
        const model = buildNotationRows(tree.root, options);
        expect(model.rows[model.rowForNode.get(tree.e5)!].type).toBe("moves");
    });
});

describe("open variations", () => {
    const shown = {
        showComments: false,
        showDiagrams: false,
        showVariations: true,
        markOpenVariations: true,
    };

    function openMoves(rows: NotationRow[]) {
        return rows.flatMap((row) => {
            if (row.type === "moves") return row.moves;
            if (row.type === "table") return [row.white, row.black].filter((move) => move !== null);
            return [];
        });
    }

    test.each([false, true])(
        "only a side line one move long carries the flag (tableView: %s)",
        (tableView) => {
            const tree = variedTree();
            // 1.e4 (1.d4) e5 (1...c5 2.Nf3 (2.Nc3)) 2.Nf3 Nc6 3.Bb5 a6
            const nc3 = fixtureNode("Nc3", { halfMoves: 3 });
            tree.c5.children = [
                fixtureNode("Nf3", { halfMoves: 3, fen: "sicilian w - - 0 1" }),
                nc3,
            ];
            nc3.comment = "still to analyse";
            nc3.nags = [2];

            const moves = openMoves(buildNotationRows(tree.root, { ...shown, tableView }).rows);

            expect(moves.filter((move) => move.openVariation).map((move) => move.node)).toEqual([
                tree.d4,
                nc3,
            ]);
            // Every printed move states it, so no consumer can read an absent flag as "not open".
            expect(moves.every((move) => typeof move.openVariation === "boolean")).toBe(true);
            // The last move of the main line and of a longer side line are continuations.
            expect(moves.find((move) => move.node === tree.a6)?.openVariation).toBe(false);
            expect(moves.find((move) => move.node === tree.c5)?.openVariation).toBe(false);

            // A notation that does not ask for the mark gets none: a puzzle solution or a
            // database preview has no line to finish.
            const unmarked = openMoves(
                buildNotationRows(tree.root, { ...shown, markOpenVariations: undefined, tableView })
                    .rows,
            );
            expect(unmarked.map((move) => move.openVariation)).toEqual(moves.map(() => false));
        },
    );

    test("the flag does not depend on the side to move at the root", () => {
        const tree = variedTree();
        const blackToMove = defaultTree(
            "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
        );
        blackToMove.root.children = tree.root.children;

        const moves = openMoves(
            buildNotationRows(blackToMove.root, { ...shown, tableView: false }).rows,
        );

        expect(moves.filter((move) => move.openVariation).map((move) => move.node)).toEqual([
            tree.d4,
            tree.c5,
        ]);
    });

    test("the keys on a path are those of the toggles that hide its side lines", () => {
        const tree = variedTree();
        const nc3 = fixtureNode("Nc3", { halfMoves: 3 });
        tree.c5.children = [fixtureNode("Nf3", { halfMoves: 3, fen: "sicilian w - - 0 1" }), nc3];
        const path = [0, 1, 1];
        expect(getNodeAtPath(tree.root, path)).toBe(nc3);

        const keys = collapseKeysOnPath(tree.root, path);

        expect(keys).toEqual([
            variationCollapseKey(tree.root, [0]),
            variationCollapseKey(tree.root, [0, 1]),
        ]);
        expect(collapseKeysOnPath(tree.root, [0, 0, 0])).toEqual([]);
        // Collapsing either toggle takes the move out of the rows; collapsing neither shows it.
        const rowsWith = (collapsed: string[]) =>
            buildNotationRows(tree.root, {
                ...shown,
                tableView: false,
                collapsedVariations: new Set(collapsed),
            });
        expect(rowsWith([]).rowForNode.has(nc3)).toBe(true);
        for (const key of keys) expect(rowsWith([key]).rowForNode.has(nc3)).toBe(false);
    });
});

describe("hiddenVariations filtering", () => {
    const baseOptions = {
        showVariations: true,
        showComments: false,
        showDiagrams: false,
    };

    test.each([false, true])(
        "hides specified side lines per sibling, reports hiddenCount, and keeps relevant siblings (tableView: %s)",
        (tableView) => {
            const tree = variedTree();
            const c4 = fixtureNode("c4");
            const e6 = fixtureNode("e6", { halfMoves: 2 });
            tree.root.children.push(c4);
            tree.e4.children.push(e6);

            const model = buildNotationRows(tree.root, {
                ...baseOptions,
                tableView,
                hiddenVariations: new Set([tree.d4, c4, e6]),
            });

            const variations = model.rows.filter((row) => row.type === "variation");
            expect(variations).toEqual([
                expect.objectContaining({
                    type: "variation",
                    parent: tree.root,
                    collapsed: false,
                    hiddenCount: 2,
                }),
                expect.objectContaining({
                    type: "variation",
                    parent: tree.e4,
                    collapsed: false,
                    hiddenCount: 1,
                }),
            ]);
            expect(moveNames(model.rows)).toEqual(["e4", "e5", "c5", "Nf3", "Nc6", "Bb5", "a6"]);
            expect(model.rowForNode.has(tree.d4)).toBe(false);
            expect(model.rowForNode.has(c4)).toBe(false);
            expect(model.rowForNode.has(e6)).toBe(false);
            expect(model.rowForNode.has(tree.c5)).toBe(true);
        },
    );

    test.each([false, true])(
        "never hides the main continuation even when named or along an excluded line (tableView: %s)",
        (tableView) => {
            const tree = variedTree();
            const bc4 = fixtureNode("Bc4", { halfMoves: 3 });
            tree.e5.children.push(bc4);

            const model = buildNotationRows(tree.root, {
                ...baseOptions,
                tableView,
                hiddenVariations: new Set([tree.e4, tree.e5, tree.nf3, tree.d4, tree.c5, bc4]),
            });

            expect(moveNames(model.rows)).toEqual(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"]);
            expect(model.rows.filter((row) => row.type === "variation")).toEqual([
                expect.objectContaining({ parent: tree.root, hiddenCount: 1 }),
                expect.objectContaining({ parent: tree.e4, hiddenCount: 1 }),
                expect.objectContaining({ parent: tree.e5, hiddenCount: 1 }),
            ]);
        },
    );

    test.each([false, true])(
        "user collapse still wins when a parent has visible and hidden side lines (tableView: %s)",
        (tableView) => {
            const tree = variedTree();
            const e6 = fixtureNode("e6", { halfMoves: 2 });
            tree.e4.children.push(e6);

            const model = buildNotationRows(tree.root, {
                ...baseOptions,
                tableView,
                collapsedVariations: new Set([variationCollapseKey(tree.root, [0])]),
                hiddenVariations: new Set([e6]),
            });

            expect(model.rowForNode.has(tree.c5)).toBe(false);
            expect(model.rowForNode.has(e6)).toBe(false);
            const e4Var = model.rows.find(
                (row) => row.type === "variation" && row.parent === tree.e4,
            );
            expect(e4Var).toMatchObject({ type: "variation", collapsed: true, hiddenCount: 1 });
        },
    );

    test.each([false, true])(
        "leaves row output identical without hiddenVariations (tableView: %s)",
        (tableView) => {
            const tree = variedTree();
            const baseline = buildNotationRows(tree.root, { ...baseOptions, tableView });
            const withEmpty = buildNotationRows(tree.root, {
                ...baseOptions,
                tableView,
                hiddenVariations: new Set(),
            });

            expect(baseline.rows).toEqual(withEmpty.rows);
            const variations = baseline.rows.filter((row) => row.type === "variation");
            expect(variations.every((row) => !Object.hasOwn(row, "hiddenCount"))).toBe(true);
        },
    );

    test("collapseKeysOnPath filters to side-line roots present in onlyNodes when provided", () => {
        const tree = variedTree();
        const nc3 = fixtureNode("Nc3", { halfMoves: 3 });
        tree.c5.children = [fixtureNode("Nf3", { halfMoves: 3, fen: "sicilian w - - 0 1" }), nc3];
        const path = [0, 1, 1];

        expect(collapseKeysOnPath(tree.root, path, new Set([nc3]))).toEqual([
            variationCollapseKey(tree.root, [0, 1]),
        ]);
        expect(collapseKeysOnPath(tree.root, path, new Set())).toEqual([]);
    });
});
