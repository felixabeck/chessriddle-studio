import { describe, expect, test } from "vitest";
import { fixtureNode } from "@/tests/treeFixtures";
import {
    buildNotationRows,
    NOTATION_ROW_MAX_MOVES,
    pathForNotationNode,
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
                    showVariations: true,
                    collapsedVariations: collapsed ? new Set([tree.e5]) : undefined,
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
                ? [{ type: "comment", depth: 0, comment: "Last played move" }]
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
                showVariations: true,
                collapsedVariations: new Set([tree.e4]),
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

    test("renders mainline and nested variations in order", () => {
        const tree = variedTree();
        const result = buildNotationRows(tree.root, {
            showVariations: true,
            showComments: true,
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
            tableView: false,
        });
        expect(moveNames(hidden.rows)).toEqual(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"]);
        expect(hidden.rows.some((row) => row.type === "comment")).toBe(false);

        const shown = buildNotationRows(tree.root, {
            showVariations: true,
            showComments: true,
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
            tableView: false,
            collapsedVariations: new Set([tree.e4]),
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
        const options = { showVariations: false, showComments: true, tableView: false };
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
        const options = { showVariations: true, showComments: true, tableView: false };
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
        ["a white move", "bb5"],
        ["a black move", "nc6"],
    ] as const)("in table view, %s keeps its comment in front of its row", (_, key) => {
        const tree = variedTree();
        tree[key].startingComment = "Before this move";
        const result = buildNotationRows(tree.root, {
            showVariations: true,
            showComments: true,
            tableView: true,
        });

        expect(commentBefore(result.rows, tree[key])).toMatchObject({
            type: "comment",
            comment: "Before this move",
        });
    });
});
