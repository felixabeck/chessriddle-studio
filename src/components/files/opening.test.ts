import { parseUci } from "chessops";
import { Chess } from "chessops/chess";
import { makeFen } from "chessops/fen";
import { parseSan } from "chessops/san";
import { type Card, createEmptyCard } from "ts-fsrs";
import { expect, test } from "vitest";
import { buildFromTree, getCardStatus, syncDeck, updateCardPerformance } from "./opening";
import { createNode, defaultTree, type TreeNode } from "@/utils/treeReducer";

function openingLine(moves: string[]): TreeNode {
    const root = defaultTree().root;
    const position = Chess.default();
    let node = root;
    for (const san of moves) {
        const move = parseSan(position, san)!;
        expect(move).toBeDefined();
        position.play(move);
        const child = createNode({
            fen: makeFen(position.toSetup()),
            move,
            san,
            halfMoves: node.halfMoves + 1,
        });
        node.children.push(child);
        node = child;
    }
    return root;
}

test.each([
    {
        name: "empty Start keeps the root skipped",
        start: [],
        moves: ["e4", "e5", "Nf3"],
        answers: ["Nf3"],
    },
    {
        name: "White-to-move Start includes its answer",
        start: [0, 0],
        moves: ["e4", "e5", "Nf3"],
        answers: ["Nf3"],
    },
    {
        name: "Black-to-move Start excludes earlier White answers",
        start: [0, 0, 0],
        moves: ["e4", "e5", "Nf3", "Nc6", "Bb5"],
        answers: ["Bb5"],
    },
])("practice $name", ({ start, moves, answers }) => {
    const root = openingLine(moves);

    expect(buildFromTree(root, "white", start).map(({ answer }) => answer)).toEqual(answers);
});

test("deck synchronization creates and retains the White-to-move Start card", () => {
    const root = openingLine(["e4", "e5", "Nf3"]);
    const created = syncDeck([], root, "white", [0, 0]);
    expect(created.positions.map(({ answer }) => answer)).toEqual(["Nf3"]);
    expect(created.added).toBe(1);

    const [existing] = buildFromTree(root, "white", []);
    existing.card.reps = 4;
    const retained = syncDeck([existing], root, "white", [0, 0]);
    expect(retained.positions).toEqual([existing]);
    expect(retained.positions[0].card).toBe(existing.card);
    expect(retained).toMatchObject({ added: 0, removed: 0, updated: 0 });
});

test("non-empty Start excludes sibling branches from practice", () => {
    const root = openingLine(["e4", "e5", "Nf3"]);
    root.children.push(...openingLine(["d4", "d5", "c4"]).children);

    expect(buildFromTree(root, "white", []).map(({ answer }) => answer)).toEqual(["Nf3", "c4"]);
    expect(buildFromTree(root, "white", [0, 0]).map(({ answer }) => answer)).toEqual(["Nf3"]);
});

test("setting Start removes a sibling-branch card during deck synchronization", () => {
    const root = openingLine(["e4", "e5", "Nf3"]);
    root.children.push(...openingLine(["d4", "d5", "c4"]).children);
    const existing = buildFromTree(root, "white", []);
    existing[0].card.reps = 4;

    const result = syncDeck(existing, root, "white", [0, 0]);

    expect(result.positions.map(({ answer }) => answer)).toEqual(["Nf3"]);
    expect(result.positions[0].card).toBe(existing[0].card);
    expect(result).toMatchObject({ added: 0, removed: 1, updated: 0 });
});

const statusNow = new Date("2026-11-08T12:00:00.000Z");
test.each([
    { name: "past ISO due", due: "2026-11-08T11:59:59.000Z", reps: 1, status: "due" },
    { name: "future ISO due", due: "2026-11-08T12:00:01.000Z", reps: 1, status: "practiced" },
    { name: "past Date due", due: new Date("2026-11-08T11:59:59.000Z"), reps: 1, status: "due" },
    {
        name: "future Date due",
        due: new Date("2026-11-08T12:00:01.000Z"),
        reps: 1,
        status: "practiced",
    },
    { name: "exact ISO due instant", due: statusNow.toISOString(), reps: 1, status: "due" },
    { name: "exact Date due instant", due: statusNow, reps: 1, status: "due" },
    { name: "unseen past due", due: "2026-11-08T11:59:59.000Z", reps: 0, status: "unseen" },
    { name: "unseen future due", due: "2026-11-08T12:00:01.000Z", reps: 0, status: "unseen" },
])("classifies a card with $name", ({ due, reps, status }) => {
    const card = { ...createEmptyCard(), due, reps } as Card;

    expect(getCardStatus(card, statusNow)).toBe(status);
});

function practiceNode(fen: string, answer: string): TreeNode {
    const position = createNode({
        fen,
        move: parseUci("e2e4")!,
        san: "e4",
        halfMoves: 2,
    });
    position.children.push(
        createNode({
            fen: `${answer} b - - 0 1`,
            move: parseUci("e7e5")!,
            san: answer,
            halfMoves: 3,
        }),
    );
    return position;
}

test("practice collapses clock-only transpositions but retains distinct positions", () => {
    const root = defaultTree().root;
    root.children.push(
        practiceNode("8/8/8/8/8/8/4P3/K6k w - - 0 12", "e5"),
        practiceNode("8/8/8/8/8/8/4P3/K6k w - - 47 99", "e6"),
        practiceNode("8/8/8/8/8/8/3P4/K6k w - - 0 12", "d5"),
    );

    const cards = buildFromTree(root, "white", []);

    expect(cards.map((card) => card.answer)).toEqual(["e5", "d5"]);
});

test("practice builds 8,000 distinct cards in walk order in under one second", () => {
    const root = defaultTree().root;
    const answers: string[] = [];
    for (let index = 0; index < 8_000; index++) {
        const pawnRanks = index
            .toString(8)
            .padStart(5, "0")
            .split("")
            .map((digit) => {
                const file = Number(digit);
                if (file === 0) return "P7";
                if (file === 7) return "7P";
                return `${file}P${7 - file}`;
            });
        const fen = `k7/${pawnRanks.join("/")}/8/K7 w - - 0 1`;
        const answer = `move-${index}`;
        root.children.push(practiceNode(fen, answer));
        answers.push(answer);
    }

    const startedAt = performance.now();
    const cards = buildFromTree(root, "white", []);
    const elapsedMs = performance.now() - startedAt;

    expect(cards).toHaveLength(8_000);
    expect(cards.map((card) => card.answer)).toEqual(answers);
    expect(elapsedMs).toBeLessThan(1_000);
});

test("deck synchronization preserves a card across clock-only FEN changes", () => {
    const originalTree = defaultTree().root;
    originalTree.children.push(practiceNode("8/8/8/8/8/8/4P3/K6k w - - 0 12", "e5"));
    const [existing] = buildFromTree(originalTree, "white", []);
    existing.card.reps = 4;

    const refreshedTree = defaultTree().root;
    refreshedTree.children.push(practiceNode("8/8/8/8/8/8/4P3/K6k w - - 30 44", "e6"));
    const result = syncDeck([existing], refreshedTree, "white", []);

    expect(result).toMatchObject({ added: 0, removed: 0, updated: 1 });
    expect(result.positions[0].card.reps).toBe(4);
    expect(result.positions[0].answer).toBe("e6");
    expect(result.positions[0].fen).toBe("8/8/8/8/8/8/4P3/K6k w - - 30 44");
});

test("deck synchronization reports a clock-only FEN change as an update", () => {
    const originalTree = defaultTree().root;
    originalTree.children.push(practiceNode("8/8/8/8/8/8/4P3/K6k w - - 0 12", "e5"));
    const [existing] = buildFromTree(originalTree, "white", []);

    const refreshedTree = defaultTree().root;
    refreshedTree.children.push(practiceNode("8/8/8/8/8/8/4P3/K6k w - - 30 44", "e5"));
    const result = syncDeck([existing], refreshedTree, "white", []);

    expect(result).toMatchObject({ added: 0, removed: 0, updated: 1 });
    expect(result.positions[0].fen).toBe("8/8/8/8/8/8/4P3/K6k w - - 30 44");
});

test("deck synchronization reports a reordering of the same cards", () => {
    const originalTree = defaultTree().root;
    originalTree.children.push(
        practiceNode("8/8/8/8/8/8/4P3/K6k w - - 0 12", "e5"),
        practiceNode("8/8/8/8/8/8/3P4/K6k w - - 0 12", "d5"),
    );
    const existing = buildFromTree(originalTree, "white", []);

    const reorderedTree = defaultTree().root;
    reorderedTree.children.push(
        practiceNode("8/8/8/8/8/8/3P4/K6k w - - 0 12", "d5"),
        practiceNode("8/8/8/8/8/8/4P3/K6k w - - 0 12", "e5"),
    );
    const result = syncDeck(existing, reorderedTree, "white", []);

    expect(result).toMatchObject({ added: 0, removed: 0, updated: 0, reordered: true });
    expect(result.positions.map((card) => card.answer)).toEqual(["d5", "e5"]);
    expect(syncDeck(existing, originalTree, "white", []).reordered).toBe(false);
});

test.each([
    { name: "addition", existing: [], fresh: [0], added: 1, removed: 0 },
    { name: "removal", existing: [0, 1], fresh: [1], added: 0, removed: 1 },
    { name: "replacement", existing: [0], fresh: [1], added: 1, removed: 1 },
    { name: "empty tree", existing: [0, 1], fresh: [], added: 0, removed: 2 },
    { name: "empty deck and tree", existing: [], fresh: [], added: 0, removed: 0 },
    { name: "unchanged deck", existing: [0, 1], fresh: [0, 1], added: 0, removed: 0 },
    { name: "duplicate and absent card", existing: [0, 0, 1], fresh: [0], added: 0, removed: 2 },
])("deck synchronization counts $name", ({ existing, fresh, added, removed }) => {
    const nodes = [
        practiceNode("8/8/8/8/8/8/4P3/K6k w - - 0 12", "e5"),
        practiceNode("8/8/8/8/8/8/3P4/K6k w - - 0 12", "d5"),
    ];
    const original = defaultTree().root;
    original.children.push(...nodes);
    const cards = buildFromTree(original, "white", []);
    const refreshed = defaultTree().root;
    refreshed.children.push(...fresh.map((index) => nodes[index]));

    const result = syncDeck(
        existing.map((index) => cards[index]),
        refreshed,
        "white",
        [],
    );

    expect(result).toMatchObject({ added, removed, updated: 0, reordered: false });
    expect(result.positions.map(({ fen }) => fen)).toEqual(fresh.map((index) => cards[index].fen));
});

const identityRefreshes = [
    {
        name: "EP",
        raw: "4k3/8/8/3p4/8/8/4P3/4K3 w - d6 0 2",
        canonical: "4k3/8/8/3p4/8/8/4P3/4K3 w - - 12 8",
    },
    {
        name: "castling",
        raw: "4k3/8/8/3p4/8/8/4P3/R3K2R w HA - 0 2",
        canonical: "4k3/8/8/3p4/8/8/4P3/R3K2R w KQ - 12 8",
    },
];

test.each(
    identityRefreshes.flatMap((identity) =>
        [false, true].map((duplicate) => ({ ...identity, duplicate })),
    ),
)(
    "$name-equivalent deck refresh retains scheduling with an admissible duplicate=$duplicate",
    ({ raw, canonical, duplicate }) => {
        const original = defaultTree().root;
        original.children.push(practiceNode(raw, "e4"));
        const [first] = buildFromTree(original, "white", []);
        first.card.reps = 4;
        const last = { ...first, fen: canonical, card: { ...first.card, reps: 9 } };
        const existing = duplicate ? [first, last] : [first];
        const refreshed = defaultTree().root;
        refreshed.children.push(practiceNode(canonical, "Kf2"), practiceNode(raw, "e4"));
        expect(
            buildFromTree(refreshed, "white", []).map(({ fen, answer }) => ({ fen, answer })),
        ).toEqual([{ fen: canonical, answer: "Kf2" }]);

        const result = syncDeck(existing, refreshed, "white", []);
        expect(result).toMatchObject({
            added: 0,
            removed: duplicate ? 1 : 0,
            updated: 1,
            reordered: false,
        });
        expect(result.positions).toHaveLength(1);
        expect(result.positions[0]).toEqual({
            ...first,
            fen: canonical,
            answer: "Kf2",
            card: duplicate ? last.card : first.card,
        });
        expect(existing[0].fen).toBe(raw);
        const review = updateCardPerformance([first], 0, first.card, 3)!;
        expect(review.entry.fen).toBe(raw);
        expect(review.entryId).toMatch(/^[0-9a-f-]{36}$/);
        expect(review.positions[0].fen).toBe(raw);
    },
);

test.each(identityRefreshes)(
    "deck synchronization signals an unchanged-answer $name duplicate removal",
    ({ raw, canonical }) => {
        const original = defaultTree().root;
        original.children.push(practiceNode(raw, "e4"));
        const [first] = buildFromTree(original, "white", []);
        first.card.reps = 4;
        const last = { ...first, fen: canonical, card: { ...first.card, reps: 9 } };
        const existing = [first, last];
        const review = updateCardPerformance([first], 0, first.card, 3)!;
        const inputBefore = structuredClone(existing);
        const reviewBefore = structuredClone(review);
        const refreshed = defaultTree().root;
        refreshed.children.push(practiceNode(canonical, "e4"));

        const result = syncDeck(existing, refreshed, "white", []);

        expect(result.positions).toEqual([last]);
        expect(result.positions[0].card).toBe(last.card);
        expect(existing).toEqual(inputBefore);
        expect(review).toEqual(reviewBefore);
        expect(review.entry.fen).toBe(raw);
        expect(review.entryId).toMatch(/^[0-9a-f-]{36}$/);
        expect(result).toMatchObject({ added: 0, removed: 1, updated: 0, reordered: false });
        expect(syncDeck(result.positions, refreshed, "white", [])).toEqual({
            positions: result.positions,
            added: 0,
            removed: 0,
            updated: 0,
            reordered: false,
        });
    },
);
